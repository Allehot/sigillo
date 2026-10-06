"""Test di Sigillo Base:  cd registratore && python -m pytest -q tests"""
import json
import re
import struct
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

RADICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RADICE))
import sigillo_base as s  # noqa: E402


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    c = s.carica_config(None)
    c.update({"registro": str(tmp_path / "reg.db"), "cartella_copie": str(tmp_path / "copie"), "copia_ogni_ore": 0,
              "vita_ferma_dopo_letture": 3})
    return c


def tipi(reg):
    return [e["tipo"] for e in reg.eventi(limite=1000, crescente=True)]


def test_decodifica():
    d = s.decodifica(s.SorgenteSimulata().leggi())
    assert d["versione"] == "COMMESSA-DEMO-V1.0" and d["versione_max"] == 30
    assert d["riferimento_valido"] and d["checksum_ok"] and len(d["checksum_att"]) == 16
    assert [e["tipo"] for e in d["eventi"]] == [1, 2]
    assert d["cpu_fw"] == d["cpu_fw_rif"] == "V4.7.0" and d["cpu_seriale"] == "S C-T8A1ACYP" and d["hw_ok"]
    assert len(d["parametri"]) == 16 and sum(p["attivo"] for p in d["parametri"]) == 4


def test_eventi_parametri_e_hardware(cfg):
    cfg["parametri"]["2"] = "Override robot [%]"
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()
    srv = s.Servizio(cfg, sim, reg)
    srv.ciclo()
    sim.evento(14, 2, 80.0, 95.5)
    sim.evento(15, 2, 95.5, 140.0)
    sim.evento(16, 2, 10.0, 100.0, 1)
    sim.evento(10)
    sim.b[s.OFF_FW_ATT + 2] = 8                 # firmware V4.8.0
    sim.evento(9, extra=0x56040800)
    srv.ciclo()
    testi = [e["descrizione"] for e in reg.eventi(limite=50, crescente=True)]
    assert "Override robot [%]: 80 -> 95.5" in testi
    assert "Override robot [%]: valore 140 rifiutato, mantenuto 95.5" in testi
    assert "Limiti di Override robot [%]: 10 - 100 (attivi)" in testi
    assert "Quadro elettrico aperto" in testi
    assert any(t.startswith("CPU diversa") and "V4.8.0" in t for t in testi)


def test_catena_e_manomissione(cfg):
    reg = s.Registro(cfg["registro"])
    for i in range(4):
        reg.aggiungi("plc", "PROVA", "info", f"evento {i}", {"n": i}, seq=i)
    assert reg.verifica()["integro"]
    c = sqlite3.connect(cfg["registro"])
    with pytest.raises(sqlite3.DatabaseError):
        c.execute("DELETE FROM registro WHERE id=2")
    c.execute("DROP TRIGGER no_update")
    c.execute("UPDATE registro SET descrizione='falso' WHERE id=2")
    c.commit()
    assert reg.verifica()["prima_voce_alterata"] == 2


def test_servizio_eventi_persi_comunicazione_vita(cfg):
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()
    srv = s.Servizio(cfg, sim, reg)
    srv.ciclo()
    assert "APPROVATO" in tipi(reg)
    for _ in range(40):                      # piu' del buffer da 32
        sim.evento(3)
    srv.ciclo()
    assert "EVENTI_PERSI" in tipi(reg)

    class Rotta:
        def leggi(self):
            raise OSError("timeout")

        def descrizione(self):
            return "rotta"
    srv.src = Rotta()
    srv.ciclo(); srv.ciclo()
    srv.src = sim
    srv.ciclo()
    assert tipi(reg).count("COMUNICAZIONE_PERSA") == 1 and "COMUNICAZIONE_OK" in tipi(reg)
    fermo = bytearray(sim.leggi())

    class Ferma:
        def leggi(self):
            return bytearray(fermo)

        def descrizione(self):
            return "ferma"
    srv.src = Ferma()
    for _ in range(5):
        srv.ciclo()
    assert "VITA_FERMA" in tipi(reg) and reg.verifica()["integro"]


def test_api(cfg):
    from fastapi.testclient import TestClient
    reg = s.Registro(cfg["registro"])
    srv = s.Servizio(cfg, s.SorgenteSimulata(), reg)
    srv.ciclo()
    c = TestClient(s.crea_app(cfg, reg, srv))
    assert c.get("/api/stato").json()["stato"]["versione"] == "COMMESSA-DEMO-V1.0"
    assert len(c.get("/api/eventi").json()) >= 3
    assert c.get("/api/verifica").json()["integro"]
    assert c.get("/api/report.pdf").content[:4] == b"%PDF"
    r = c.post("/api/esporta").json()
    assert Path(r["file"]).exists() and (Path(cfg["cartella_copie"]) / "verifica_registro.html").exists()
    assert c.get("/").status_code == 200 and c.get("/verifica").status_code == 200


def test_verificatore_offline_compatibile(cfg, tmp_path):
    if not shutil.which("node"):
        pytest.skip("node non disponibile")
    reg = s.Registro(cfg["registro"])
    reg.aggiungi("plc", "APPROVATO", "info", "Programma approvato (àè €)", {"x": 1}, "2026-10-01T10:00:00", 0)
    reg.aggiungi("plc", "PROGRAMMA_DIVERSO", "allarme", "diverso", {"y": 2}, seq=5)
    esp = reg.esporta(cfg["cartella_copie"])
    codice = re.search(r"<script>(.*)</script>", (RADICE / "static" / "verifica.html").read_text(), re.S).group(1)
    js = tmp_path / "v.js"
    js.write_text(codice[: codice.index("const leggi")] + """
const r = require("fs").readFileSync(process.argv[2], "utf8").split("\\n").filter(Boolean).map(JSON.parse);
let p = "0".repeat(64), ok = true; for (const v of r) { if (impronta(p, v) !== v.hash) ok = false; p = v.hash; }
console.log(ok ? "OK" : "KO");""")
    assert subprocess.run(["node", str(js), esp["file"]], capture_output=True, text=True).stdout.strip() == "OK"


def test_jsobject(tmp_path):
    if not shutil.which("node"):
        pytest.skip("node non disponibile")
    (tmp_path / "db.bin").write_bytes(bytes(s.SorgenteSimulata().leggi()))
    out = subprocess.run(["node", str(RADICE / "tests" / "banco_jsobject.js"),
                          str(RADICE.parent / "weintek" / "SigilloBase_JSObject.js"), str(tmp_path / "db.bin")],
                         capture_output=True, text=True, timeout=60)
    esito = json.loads(out.stdout.strip().splitlines()[-1])
    assert "eccezione" not in esito, esito
    assert all(esito.values()), [k for k, v in esito.items() if not v]


# ---------------------------------------------------------------- collegamenti (rete e Syslog)
import socket  # noqa: E402
import time  # noqa: E402

import collegamenti as col  # noqa: E402

ARP_WINDOWS = """
Interfaccia: 192.168.0.10 --- 0xb
  Indirizzo Internet    Indirizzo fisico      Tipo
  192.168.0.1           00-1b-1b-12-34-56     dinamico
  192.168.0.50          a4-5e-60-aa-bb-cc     dinamico
  192.168.0.255         ff-ff-ff-ff-ff-ff     statico
  224.0.0.22            01-00-5e-00-00-16     statico
"""
ARP_LINUX = """192.168.0.1 dev eth0 lladdr 00:1b:1b:12:34:56 REACHABLE
192.168.0.77 dev eth0 lladdr 3c:52:82:01:02:03 STALE
192.168.0.99 dev eth0  FAILED
"""


def test_tabella_arp_windows_e_linux():
    assert col.leggi_tabella_arp(ARP_WINDOWS) == {"192.168.0.1": "00:1B:1B:12:34:56", "192.168.0.50": "A4:5E:60:AA:BB:CC"}
    assert col.leggi_tabella_arp(ARP_LINUX) == {"192.168.0.1": "00:1B:1B:12:34:56", "192.168.0.77": "3C:52:82:01:02:03"}


class ScannerFinto:
    def __init__(self):
        self.presenti = {}

    def scansiona(self, sottorete):
        return dict(self.presenti)


def test_rete_noti_online_offline_esterni_e_mac(cfg):
    cfg["rete"] = {"abilitato": True, "sottorete": "192.168.0.0/24",
                   "noti": {"192.168.0.1": {"nome": "PLC", "mac": "00:1B:1B:12:34:56"}, "192.168.0.10": "Robot R1"}}
    reg, sc = s.Registro(cfg["registro"]), ScannerFinto()
    r = col.ControlloRete(cfg, reg, sc)
    r.locali = set()
    sc.presenti = {"192.168.0.1": "00:1B:1B:12:34:56"}
    r.ciclo()
    assert tipi(reg) == ["RETE_STATO_INIZIALE"] and "1 online, 1 offline (Robot R1)" in reg.eventi(1)[0]["descrizione"]
    sc.presenti["192.168.0.10"] = "AA:BB:CC:00:00:10"           # il robot si accende
    r.ciclo()
    assert tipi(reg)[-1] == "DISPOSITIVO_ONLINE" and "Robot R1 (192.168.0.10) di nuovo online" in reg.eventi(1)[0]["descrizione"]
    del sc.presenti["192.168.0.10"]
    r.ciclo(); r.ciclo()
    assert tipi(reg)[-1] == "DISPOSITIVO_ONLINE"                 # tollera due scansioni perse
    r.ciclo()
    assert tipi(reg)[-1] == "DISPOSITIVO_OFFLINE" and r.noti_offline() == ["192.168.0.10"]
    sc.presenti["192.168.0.50"] = "A4:5E:60:AA:BB:CC"           # arriva un portatile
    r.ciclo()
    assert tipi(reg)[-1] == "DISPOSITIVO_ESTERNO" and r.esterni() == ["192.168.0.50"]
    el = r.elenco()
    assert [d["ip"] for d in el] == ["192.168.0.1", "192.168.0.10", "192.168.0.50"]
    assert [(d["noto"], d["online"]) for d in el] == [(True, True), (True, False), (False, True)]
    r.approva("192.168.0.50", "Portatile SDM", "Alle")
    assert tipi(reg)[-1] == "DISPOSITIVO_APPROVATO" and r.esterni() == []
    assert r.noti()["192.168.0.50"]["mac"] == "A4:5E:60:AA:BB:CC"
    assert r.revoca("192.168.0.50", "Alle") and r.esterni() == ["192.168.0.50"]
    del sc.presenti["192.168.0.1"]
    for _ in range(3):
        r.ciclo()
    sc.presenti["192.168.0.1"] = "DE:AD:BE:EF:00:01"            # stesso IP del PLC, scheda diversa
    r.ciclo()
    assert "MAC_DIVERSO" in tipi(reg)[-2:]


def test_syslog_ricezione_reale(cfg):
    cfg["syslog"] = {"abilitato": True, "porta": 0, "indirizzo": "127.0.0.1", "sorgenti": ["127.0.0.1"]}
    reg = s.Registro(cfg["registro"])
    rx = col.RicevitoreSyslog(cfg, reg)
    porta = rx.apri()
    import threading
    threading.Thread(target=rx.esegui, daemon=True).start()
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tx.sendto(b"<38>1 2026-10-05T10:00:00Z PLC_1 - - - Session established, user logon successful", ("127.0.0.1", porta))
    tx.sendto(b"<14>Diagnostic message", ("127.0.0.1", porta))
    for _ in range(50):
        if len(tipi(reg)) >= 2:
            break
        time.sleep(0.05)
    assert tipi(reg) == ["ACCESSO_CPU", "SYSLOG_CPU"] and rx.accesso_recente()
    rx.gestisci(b"login", "10.0.0.9")                 # sorgente non ammessa: ignorata
    assert len(tipi(reg)) == 2


def test_il_registratore_non_scrive_nel_plc(cfg):
    """v2.0: elenco della rete, MAC, approvazioni e commenti restano nel registratore."""
    class SoloLettura(s.SorgenteSimulata):
        def scrivi(self, offset, dati):
            raise AssertionError(f"scrittura nel PLC non prevista (byte {offset})")
    reg = s.Registro(cfg["registro"])
    srv = s.Servizio(cfg, SoloLettura(), reg)
    cfg["rete"] = {"sottorete": "192.168.0.0/24", "noti": {"192.168.0.1": "PLC"}}
    srv.rete = col.ControlloRete(cfg, reg, ScannerFinto())
    srv.rete.locali = set()
    srv.rete.scanner.presenti = {"192.168.0.1": "00:1B:1B:12:34:56", "192.168.0.50": "A4:5E:60:AA:BB:CC"}
    srv.rete.ciclo()
    srv.ciclo(); srv.ciclo()
    assert "SCRITTURA_PLC_ERRORE" not in tipi(reg)


def test_api_del_pannello_con_token(cfg):
    from fastapi.testclient import TestClient
    cfg["token_pannello"] = "abc"
    cfg["rete"] = {"sottorete": "192.168.0.0/24", "noti": {"192.168.0.1": "PLC"}}
    reg = s.Registro(cfg["registro"])
    srv = s.Servizio(cfg, s.SorgenteSimulata(), reg)
    srv.rete = col.ControlloRete(cfg, reg, ScannerFinto())
    srv.rete.locali = {"192.168.0.60"}
    srv.rete.scanner.presenti = {"192.168.0.1": "00:1B:1B:12:34:56", "192.168.0.50": "A4:5E:60:AA:BB:CC"}
    srv.rete.ciclo()
    srv.ciclo()
    c = TestClient(s.crea_app(cfg, reg, srv))
    assert c.get("/api/pannello?token=sbagliato").status_code == 401 and "TOKEN_ERRATO" in tipi(reg)
    p = c.get("/api/pannello?token=abc").json()
    assert p["esterni"] == 1 and [d["ip"] for d in p["rete"]] == ["192.168.0.1", "192.168.0.60", "192.168.0.50"]
    assert p["rete"][1]["locale"] and p["rete"][1]["nome"] == "Questo PC"      # prima i noti, poi i non noti
    assert c.post("/api/pannello/approva", data={"token": "abc", "ip": "192.168.0.50"}).status_code == 200
    assert "pannello HMI" in reg.eventi(1)[0]["descrizione"] and srv.rete.esterni() == []
    # commenti: PROFINET, Ethernet e rete
    assert c.post("/api/pannello/commento", data={"token": "abc", "tipo": "profinet", "indice": 1, "testo": "nastro 1"}).status_code == 200
    assert c.post("/api/pannello/commento", data={"token": "abc", "tipo": "ethernet", "ip": "192.168.0.11", "testo": "cella 2"}).status_code == 200
    assert c.post("/api/pannello/commento", data={"token": "abc", "tipo": "rete", "ip": "192.168.0.1", "testo": "CPU linea"}).status_code == 200
    p = c.get("/api/pannello?token=abc").json()
    assert p["commenti"] == {"pn:1": "nastro 1", "eth:192.168.0.11": "cella 2"} and p["rete"][0]["commento"] == "CPU linea"
    # elenco Ethernet salvato nel pannello
    righe = '[{"riga": 1, "ip": "192.168.0.11", "porta": 80, "nome": "Telecamera"}]'
    assert c.post("/api/pannello/ethernet", data={"token": "abc", "righe": righe}).status_code == 200
    m = c.get("/api/stato").json()["macchina"]
    assert m["ethernet"][0]["nome"] == "Telecamera" and m["ethernet"][0]["commento"] == "cella 2"
    assert m["profinet"][0]["nome"] == "sew-movimot-1" and m["profinet"][0]["commento"] == "nastro 1"
    # senza token configurato l'API del pannello e' spenta
    cfg["token_pannello"] = ""
    assert c.get("/api/pannello?token=abc").status_code == 403


def test_commenti_dalla_pagina_web_con_pin(cfg):
    from fastapi.testclient import TestClient
    cfg["pin_dispositivi"] = "1234"
    reg = s.Registro(cfg["registro"])
    srv = s.Servizio(cfg, s.SorgenteSimulata(), reg)
    srv.ciclo()
    c = TestClient(s.crea_app(cfg, reg, srv))
    assert c.post("/api/commento", data={"tipo": "profinet", "indice": 2, "testo": "x", "pin": "0"}).status_code == 401
    assert c.post("/api/commento", data={"tipo": "profinet", "indice": 2, "testo": "master IO-Link cella 1",
                                         "chi": "Alle", "pin": "1234"}).status_code == 200
    assert srv.commenti() == {"pn:2": "master IO-Link cella 1"} and "Alle" in reg.eventi(1)[0]["descrizione"]


def test_api_dispositivi_con_pin(cfg):
    from fastapi.testclient import TestClient
    cfg["pin_dispositivi"] = "1234"
    cfg["rete"] = {"sottorete": "192.168.0.0/24", "noti": {}}
    reg = s.Registro(cfg["registro"])
    srv = s.Servizio(cfg, s.SorgenteSimulata(), reg)
    srv.rete = col.ControlloRete(cfg, reg, ScannerFinto())
    srv.rete.locali = set()
    srv.rete.scanner.presenti = {"192.168.0.50": "A4:5E:60:AA:BB:CC"}
    srv.rete.ciclo()
    c = TestClient(s.crea_app(cfg, reg, srv))
    assert c.get("/api/collegamenti").json()["rete"]["dispositivi"][0]["noto"] is False
    assert c.post("/api/dispositivi/approva", data={"ip": "192.168.0.50", "nome": "Portatile", "pin": "0"}).status_code == 401
    assert "PIN_ERRATO" in tipi(reg)
    assert c.post("/api/dispositivi/approva", data={"ip": "192.168.0.50", "nome": "Portatile", "chi": "Alle", "pin": "1234"}).status_code == 200
    d = c.get("/api/collegamenti").json()["rete"]["dispositivi"][0]
    assert d["noto"] and d["nome"] == "Portatile" and d["approvato_da"] == "Alle"
    assert c.post("/api/dispositivi/revoca", data={"ip": "192.168.0.50", "pin": "1234"}).json()["ok"]


def test_dispositivi_macchina_profinet_ethernet(cfg):
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()
    d = s.decodifica(sim.leggi())
    assert [(x["n"], x["nome"], x["online"]) for x in d["profinet"]] == [(1, "sew-movimot-1", True), (2, "tbn-ll-8iol", False)]
    assert d["ethernet"] == [{"n": 1, "online": True}, {"n": 2, "online": False}]
    srv = s.Servizio(cfg, sim, reg)
    srv.imposta_eth_pannello([{"riga": 1, "ip": "192.168.0.11", "porta": 80, "nome": "Telecamera"}])
    srv.ciclo()
    sim.evento(18, 2)
    sim.evento(21, 1)
    sim.evento(26, 3, extra=0x8090)
    srv.ciclo()
    testi = [e["descrizione"] for e in reg.eventi(limite=20, crescente=True)]
    assert "PROFINET tbn-ll-8iol offline" in testi
    assert "Ethernet Telecamera (192.168.0.11) di nuovo online (controllo del pannello)" in testi
    assert "Nome del dispositivo PROFINET n. 3 non leggibile (STATUS 8090)" in testi
    assert "ETHERNET_ELENCO" in tipi(reg)


# ---------------------------------------------------------------- stato della CPU (v2.1)
def test_modo_da_szl_snap7_1_e_3():
    record = bytes([0x43, 0x01, 0xFF, 0x08]) + bytes(16)               # snap7 1.x: solo il record
    assert s.modo_da_szl(record) == ("RUN", 0x08)
    assert s.modo_da_szl(bytes([0, 20, 0, 1]) + record) == ("RUN", 0x08)  # snap7 3.x: lunghezza e n. record prima
    assert s.modo_da_szl(bytes([0x43, 0x01, 0xFF, 0x04]))[0] == "STOP"
    assert s.modo_da_szl(bytes([0x43, 0x01, 0xFF, 0x03]))[0] == "STOP"
    assert s.modo_da_szl(bytes([0x43, 0x01, 0xFF, 0x05]))[0] == "AVVIO"
    assert s.modo_da_szl(bytes(8)) == (None, None)


def test_decodifica_cpu():
    sim = s.SorgenteSimulata()
    c = s.decodifica(sim.leggi())["cpu"]
    assert 3.5 <= c["ciclo_ms"] <= 5.0 and c["ciclo_min_ms"] <= c["ciclo_ms"] <= c["ciclo_max_ms"]
    assert c["avvii"] == 3 and 4990 <= c["secondi_da_avvio"] <= 5010
    assert "ora" not in c                                                  # l'ora della CPU non si usa
    assert s.decodifica_cpu(bytearray(1822)) is None                       # DB della v2.0


def test_cpu_run_stop_e_avvii(cfg):
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()
    srv = s.Servizio(cfg, sim, reg)
    srv.ciclo()
    assert "Avvio o reinizializzazione del programma PLC (avvio n. 3)" in [e["descrizione"] for e in reg.eventi(10)]
    assert srv.stato_cpu()["modo"] == "RUN" and srv.stato_cpu()["avvii"] == 3
    sim.modo = "STOP"
    for _ in range(5):
        srv.ciclo()
    assert tipi(reg).count("CPU_STOP") == 1 and "VITA_FERMA" not in tipi(reg)   # STOP spiega la vita ferma
    sim.modo = "RUN"
    srv.ciclo(); srv.ciclo()
    assert tipi(reg)[-1] == "CPU_RUN"
    assert not any(t.startswith("ORA_CPU") for t in tipi(reg)) and reg.verifica()["integro"]
    # un registratore riavviato non ripete lo stato gia' registrato
    srv2 = s.Servizio(cfg, sim, reg)
    srv2.ciclo()
    assert tipi(reg).count("CPU_RUN") == 1


def test_vita_ferma_con_cpu_in_run(cfg):
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()
    srv = s.Servizio(cfg, sim, reg)
    fermo = bytearray(sim.leggi())

    class FbFermo:
        def leggi(self):
            return bytearray(fermo)

        def modo_cpu(self):
            return "RUN", 0x08

        def descrizione(self):
            return "fb fermo"
    srv.src = FbFermo()
    for _ in range(4):
        srv.ciclo()
    assert "FB_SigilloBase non in esecuzione (CPU in RUN)" in [e["descrizione"] for e in reg.eventi(5)]


def test_modo_non_leggibile(cfg):
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()

    def guasto():
        raise RuntimeError("Read SZL failed")
    sim.modo_cpu = guasto
    srv = s.Servizio(cfg, sim, reg)
    srv.ciclo()
    assert srv.stato_cpu()["modo"] is None and "SZL" in srv.cpu["errore_modo"] and "CPU_STOP" not in tipi(reg)


def test_api_cpu(cfg):
    from fastapi.testclient import TestClient
    cfg["token_pannello"] = "abc"
    reg, sim = s.Registro(cfg["registro"]), s.SorgenteSimulata()
    srv = s.Servizio(cfg, sim, reg)
    srv.ciclo(); srv.ciclo()
    c = TestClient(s.crea_app(cfg, reg, srv))
    cpu = c.get("/api/stato").json()["cpu"]
    assert cpu["modo"] == "RUN" and cpu["szl_bzu"] == "08" and cpu["avvii"] == 3 and cpu["ciclo_max_ms"] > 0
    assert c.get("/api/pannello?token=abc").json()["cpu"]["modo"] == "RUN"


def test_sorgente_plc_modo_dalla_szl(cfg):
    pytest.importorskip("snap7")
    from snap7.type import S7SZL
    src = s.SorgentePLC(cfg)

    class Cli:
        def __init__(self, dati):
            self.dati = dati

        def read_szl(self, ssl_id, index):
            assert (ssl_id, index) == (0x0424, 0)
            szl = S7SZL()
            szl.Header.LengthDR = len(self.dati)
            for i, b in enumerate(self.dati):
                szl.Data[i] = b
            return szl
    src.cli = Cli(bytes([0, 20, 0, 1, 0x43, 0x01, 0xFF, 0x04]) + bytes(16))   # come snap7 3.x
    assert src.modo_cpu() == ("STOP", 0x04)
    src.cli = Cli(bytes([0x43, 0x01, 0xFF, 0x08]) + bytes(16))                 # come snap7 1.x
    assert src.modo_cpu() == ("RUN", 0x08)
