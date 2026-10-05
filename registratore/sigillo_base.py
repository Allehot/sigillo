#!/usr/bin/env python3
"""
Sigillo Base - registratore delle modifiche al programma PLC (S7-1200 / S7-1500).

Legge "DB_SigilloBase" via S7, archivia gli eventi in un registro SQLite a sola aggiunta con
catena di hash SHA-256, mostra una pagina web e produce il report PDF.

    python sigillo_base.py avvia    --config config.json            # servizio
    python sigillo_base.py avvia    --config config.json --simula   # senza PLC
    python sigillo_base.py verifica --config config.json            # 0 = integro, 2 = alterato
    python sigillo_base.py report   --config config.json --out registro.pdf
    python sigillo_base.py esporta  --config config.json            # copia + ancora + verificatore
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import random
import sqlite3
import struct
import threading
import time
from pathlib import Path

GENESI = "0" * 64
TIPI = {
    1: ("AVVIO_PLC", "info", "Avvio o reinizializzazione del programma PLC"),
    2: ("APPROVATO", "info", "Programma approvato"),
    3: ("PROGRAMMA_DIVERSO", "allarme", "Programma diverso da quello approvato"),
    4: ("PROGRAMMA_OK", "info", "Programma tornato uguale a quello approvato"),
    5: ("FIRMA_F", "allarme", "Firma del programma di sicurezza cambiata"),
    6: ("AVVIO_BLOCCATO", "allarme", "Avvio automatico bloccato"),
    7: ("AVVIO_SBLOCCATO", "attenzione", "Avvio automatico sbloccato"),
    8: ("ERRORE_CHECKSUM", "attenzione", "Errore nella lettura del checksum"),
    9: ("HARDWARE_DIVERSO", "allarme", "CPU diversa da quella approvata (firmware o numero di serie)"),
    10: ("QUADRO_APERTO", "attenzione", "Quadro elettrico aperto"),
    11: ("QUADRO_CHIUSO", "info", "Quadro elettrico chiuso"),
    12: ("MANUTENZIONE_ON", "info", "Modalita' manutenzione inserita"),
    13: ("MANUTENZIONE_OFF", "info", "Modalita' manutenzione disinserita"),
    14: ("PARAMETRO", "info", "Parametro modificato"),
    15: ("FUORI_LIMITE", "attenzione", "Valore fuori limite rifiutato"),
    16: ("LIMITI", "attenzione", "Limiti di un parametro modificati"),
    17: ("ERRORE_IM", "attenzione", "Lettura firmware e numero di serie della CPU non riuscita"),
    18: ("PROFINET_OFFLINE", "attenzione", "Dispositivo PROFINET offline"),
    19: ("PROFINET_ONLINE", "info", "Dispositivo PROFINET di nuovo online"),
    20: ("ETHERNET_OFFLINE", "attenzione", "Dispositivo Ethernet offline"),
    21: ("ETHERNET_ONLINE", "info", "Dispositivo Ethernet di nuovo online"),
    26: ("NOME_PN_ERRORE", "attenzione", "Nome PROFINET non leggibile"),
}
CONFIG_DEFAULT = {
    "macchina": "Macchina di prova",
    "matricola": "",
    "plc": {"ip": "192.168.0.1", "rack": 0, "slot": 1, "db": 6},
    "periodo_lettura_s": 2.0,
    "vita_ferma_dopo_letture": 5,
    "registro": "registro_sigillo_base.db",
    "cartella_copie": "copie",
    "copia_ogni_ore": 24,
    "web": {"host": "0.0.0.0", "porta": 8150},
    "parametri": {str(i): f"Parametro {i}" for i in range(1, 17)},
    "rete": {"abilitato": False, "sottorete": "192.168.0.0/24", "periodo_s": 15, "noti": {}},
    "pin_dispositivi": "",    # PIN per approvare/revocare/commentare dalla pagina web
    "token_pannello": "",     # chiave condivisa con il JS Object del pannello (vuoto = API del pannello spenta)
    "nomi_profinet": {},      # n. dispositivo PROFINET -> nome (come in TIA)
    "nomi_ethernet": {},      # riga dell'elenco Ethernet del pannello -> nome
    "syslog": {"abilitato": False, "porta": 514, "sorgenti": [], "accesso_minuti": 5},
    "tolleranza_ora_s": 60,   # differenza massima tra l'orologio della CPU e quello di questo PC
}

# Disposizione di DB_SigilloBase (accesso standard, big-endian)
DIM_DB = 1856
OFF_EVENTI, N_EVENTI, DIM_EVENTO = 70, 32, 32
# Seq, Tipo, Indice, DTL (anno, mese, giorno, giorno sett., ora, min, sec, ns), Extra, ValPrec, ValNuovo
FMT_EVENTO = ">ihhHBBBBBBIIff"
OFF_LIMITI, OFF_PARAM, OFF_HW = 1094, 1254, 1318
OFF_FW_ATT, OFF_FW_RIF, OFF_SER_ATT, OFF_SER_RIF = 1320, 1324, 1328, 1346
OFF_PN_CFG, OFF_PN_PRES, OFF_ETH = 1364, 1380, 1396     # dispositivi della macchina (stato)
OFF_PN_NOMI, OFF_PN_ERR = 1404, 1820                    # nomi PROFINET letti con Get_Name (16 x String[24])
OFF_CPU = 1822                                          # stato della CPU: cicli, ora, avvii, tempo dall'avvio
FMT_DTL = ">HBBBBBBI"
assert struct.calcsize(FMT_EVENTO) == DIM_EVENTO


def carica_config(percorso):
    cfg = json.loads(json.dumps(CONFIG_DEFAULT))
    if percorso and Path(percorso).exists():
        for k, v in json.loads(Path(percorso).read_text(encoding="utf-8")).items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


def adesso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _stringa_s7(b, o):
    return bytes(b[o + 2:o + 2 + min(b[o + 1], b[o])]).decode("latin-1", "replace").strip()


def leggi_dtl(b, o):
    """DTL del PLC -> datetime (None se vuoto o non valido)."""
    anno, mese, giorno, _wd, ora, mi, se, ns = struct.unpack_from(FMT_DTL, b, o)
    try:
        return dt.datetime(anno, mese, giorno, ora, mi, se, ns // 1000) if anno else None
    except ValueError:
        return None


def durata_testo(secondi):
    secondi = int(abs(secondi))
    if secondi < 120:
        return f"{secondi} s"
    if secondi < 7200:
        return f"{secondi // 60} min"
    if secondi < 172800:
        return f"{secondi // 3600} h {secondi % 3600 // 60} min"
    return f"{secondi // 86400} g {secondi % 86400 // 3600} h"


def modo_da_szl(dati):
    """Modo operativo della CPU dal record della SZL 0x0424 -> ("RUN" | "AVVIO" | "STOP" | None, bzu-id).

    Record: ereig (2 byte), ae (1 byte, sempre FF), bzu-id (1 byte, bit 0..3 = modo: 8 RUN, 5..7 avvio,
    gli altri STOP). snap7 1.x restituisce il record da solo, snap7 3.x lo fa precedere dalla
    lunghezza e dal numero dei record (4 byte): il record si riconosce dal byte ae = FF.
    """
    for o in (0, 4):
        if len(dati) >= o + 4 and dati[o + 2] == 0xFF:
            bzu = dati[o + 3]
            m = bzu & 0x0F
            return ("RUN" if m in (8, 9) else "AVVIO" if m in (5, 6, 7) else None if m == 0 else "STOP"), bzu
    return None, None


def decodifica_cpu(b):
    """Stato della CPU scritto dal FB (v2.1); None con un DB della v2.0."""
    if b is None or len(b) < DIM_DB:
        return None
    att, mn, mx = struct.unpack_from(">fff", b, OFF_CPU)
    ora = leggi_dtl(b, OFF_CPU + 12)
    avvii, secondi = struct.unpack_from(">ii", b, OFF_CPU + 24)
    return {"ciclo_ms": round(att, 3), "ciclo_min_ms": round(mn, 3), "ciclo_max_ms": round(mx, 3),
            "ora": ora.isoformat(timespec="seconds") if ora else None, "avvii": avvii, "secondi_da_avvio": secondi}


def nome_pn(b, n):
    """Nome PROFINET del dispositivo n letto dalla CPU ('' se non letto o n > 16)."""
    if b is None or len(b) < DIM_DB or not 1 <= n <= 16:
        return ""
    return _stringa_s7(b, OFF_PN_NOMI + (n - 1) * 26)


def decodifica(b):
    stato = b[12]
    vmax, vlen = b[38], b[39]
    eventi = []
    for n in range(N_EVENTI):
        (seq, tipo, indice, anno, mese, giorno, _wd, ora, mi, se, ns, extra, vp, vn) = \
            struct.unpack_from(FMT_EVENTO, b, OFF_EVENTI + n * DIM_EVENTO)
        if seq > 0:
            try:
                ts = dt.datetime(anno, mese, giorno, ora, mi, se, ns // 1000).isoformat(timespec="seconds")
            except ValueError:
                ts = None
            eventi.append({"seq": seq, "tipo": tipo, "indice": indice, "ts_plc": ts, "extra": extra,
                           "val_prec": round(vp, 4), "val_nuovo": round(vn, 4)})
    limiti = []
    for n in range(16):
        mn, mx = struct.unpack_from(">ff", b, OFF_LIMITI + n * 10)
        limiti.append({"n": n + 1, "min": round(mn, 4), "max": round(mx, 4), "attivo": bool(b[OFF_LIMITI + n * 10 + 8] & 1),
                       "valore": round(struct.unpack_from(">f", b, OFF_PARAM + n * 4)[0], 4)})

    def fw(o):
        v = bytes(b[o:o + 4])
        return f"{chr(v[0]) if 32 < v[0] < 127 else 'V'}{v[1]}.{v[2]}.{v[3]}" if any(v) else ""

    def stringa(o):
        return bytes(b[o + 2:o + 2 + min(b[o + 1], b[o])]).decode("latin-1", "replace").strip()
    return {
        "vita": struct.unpack_from(">i", b, 0)[0], "seq_ultimo": struct.unpack_from(">i", b, 4)[0],
        "riferimento_valido": bool(stato & 1), "checksum_ok": bool(stato & 2), "firma_f_ok": bool(stato & 4),
        "avvio_bloccato": bool(stato & 8), "errore_lettura": bool(stato & 16), "hw_ok": bool(stato & 32),
        "quadro_aperto": bool(b[OFF_HW] & 1), "manutenzione": bool(b[OFF_HW] & 2), "errore_im": bool(b[OFF_HW] & 4),
        "cpu_fw": fw(OFF_FW_ATT), "cpu_fw_rif": fw(OFF_FW_RIF),
        "cpu_seriale": stringa(OFF_SER_ATT), "cpu_seriale_rif": stringa(OFF_SER_RIF), "parametri": limiti,
        "profinet": [{"n": n, "online": bool(b[OFF_PN_PRES + n // 8] >> (n % 8) & 1), "nome": nome_pn(b, n),
                      "errore_nome": n <= 16 and bool(b[OFF_PN_ERR + (n - 1) // 8] >> ((n - 1) % 8) & 1)}
                     for n in range(1, 128) if b[OFF_PN_CFG + n // 8] >> (n % 8) & 1],
        "ethernet": [{"n": i + 1, "online": bool(struct.unpack_from(">H", b, OFF_ETH + 2)[0] >> i & 1)}
                     for i in range(16) if struct.unpack_from(">H", b, OFF_ETH)[0] >> i & 1],
        "firma_f_rif": f"{struct.unpack_from('>I', b, 14)[0]:08X}", "firma_f_att": f"{struct.unpack_from('>I', b, 18)[0]:08X}",
        "checksum_rif": bytes(b[22:30]).hex().upper(), "checksum_att": bytes(b[30:38]).hex().upper(),
        "versione": bytes(b[40:40 + min(vlen, vmax)]).decode("latin-1", "replace").strip(), "versione_max": vmax,
        "cpu": decodifica_cpu(b), "eventi": sorted(eventi, key=lambda e: e["seq"]),
    }


# ------------------------------------------------------------------ sorgenti
class SorgentePLC:
    def __init__(self, cfg):
        import snap7
        self.cfg, self.cli = cfg, snap7.client.Client()

    def leggi(self):
        p = self.cfg["plc"]
        if not self.cli.get_connected():
            self.cli.connect(p["ip"], p["rack"], p["slot"])
        return bytearray(self.cli.db_read(p["db"], 0, DIM_DB))

    def scrivi(self, offset, dati):
        self.cli.db_write(self.cfg["plc"]["db"], offset, bytearray(dati))

    def modo_cpu(self):
        """RUN / STOP letto direttamente dalla CPU (SZL 0x0424, modo operativo attuale).

        DA VERIFICARE AL BANCO: il byte bzu-id viene mostrato nella pagina web (stato della CPU).
        get_cpu_state() si usa solo con snap7 1.x: nella 3.x restituisce sempre RUN senza chiedere alla CPU.
        """
        try:
            szl = self.cli.read_szl(0x0424, 0)
            return modo_da_szl(bytes(szl.Data[:max(int(szl.Header.LengthDR), 24)]))
        except Exception:
            if not snap7_libreria_c():
                raise
            return {"S7CpuStatusRun": "RUN", "S7CpuStatusStop": "STOP"}.get(self.cli.get_cpu_state()), None

    def descrizione(self):
        p = self.cfg["plc"]
        return f"PLC {p['ip']}, DB{p['db']}"


def snap7_libreria_c():
    """True con python-snap7 1.x/2.x (libreria C), dove get_cpu_state() interroga davvero la CPU."""
    try:
        from importlib.metadata import version
        return int(version("python-snap7").split(".")[0]) < 3
    except Exception:
        return False


class SorgenteSimulata:
    """Riproduce FB_SigilloBase nello stesso formato del DB (prove senza PLC)."""

    def __init__(self):
        self.b = bytearray(DIM_DB)
        self.seq = self.idx = self.vita = 0
        self.chk = os.urandom(8)
        self.rif = bytes(self.chk)
        self.bloccato = self.quadro = False
        self.modo, self.avvii, self.avvio = "RUN", 3, time.time() - 5000
        self.scarto_ora = 0.0                      # secondi di errore dell'orologio della CPU simulata
        self.param = [round(random.uniform(10, 500), 1) for _ in range(16)]
        self.limiti = [(round(p * 0.5, 1), round(p * 1.5, 1), i < 4) for i, p in enumerate(self.param)]
        self._stringa(38, 30, b"COMMESSA-DEMO-V1.0")
        for o in (OFF_SER_ATT, OFF_SER_RIF):
            self._stringa(o, 16, b"S C-T8A1ACYP")
        for o in (OFF_FW_ATT, OFF_FW_RIF):
            self.b[o:o + 4] = bytes([ord("V"), 4, 7, 0])
        self.evento(1, vn=float(self.avvii))
        self.evento(2, extra=int.from_bytes(self.chk[:4], "big"))
        self.ultimo = time.time()

    def _stringa(self, o, vmax, testo):
        self.b[o], self.b[o + 1] = vmax, len(testo)
        self.b[o + 2:o + 2 + len(testo)] = testo

    def evento(self, tipo, indice=0, vp=0.0, vn=0.0, extra=0):
        self.seq += 1
        t = dt.datetime.now()
        struct.pack_into(FMT_EVENTO, self.b, OFF_EVENTI + self.idx * DIM_EVENTO, self.seq, tipo, indice, t.year,
                         t.month, t.day, t.isoweekday() % 7 + 1, t.hour, t.minute, t.second, t.microsecond * 1000,
                         extra, vp, vn)
        self.idx = (self.idx + 1) % N_EVENTI

    def modo_cpu(self):
        return self.modo, 0x08 if self.modo == "RUN" else 0x04

    def leggi(self):
        if self.modo != "RUN":                     # in STOP il FB non gira: vita, ora e cicli fermi
            return bytearray(self.b)
        self.vita += 41
        att = round(random.uniform(3.5, 5.0), 3)
        mn, mx = struct.unpack_from(">ff", self.b, OFF_CPU + 4)
        t = dt.datetime.now() + dt.timedelta(seconds=self.scarto_ora)
        struct.pack_into(">fff", self.b, OFF_CPU, att, min(mn or att, att), max(mx, att))
        struct.pack_into(FMT_DTL, self.b, OFF_CPU + 12, t.year, t.month, t.day, t.isoweekday() % 7 + 1,
                         t.hour, t.minute, t.second, t.microsecond * 1000)
        struct.pack_into(">ii", self.b, OFF_CPU + 24, self.avvii, int(time.time() - self.avvio))
        if time.time() - self.ultimo > 4:
            self.ultimo = time.time()
            r = random.random()
            if r < 0.35:
                i = random.randint(1, 16)
                vp = self.param[i - 1]
                self.param[i - 1] = round(vp * random.uniform(0.9, 1.1), 1)
                self.evento(14, i, vp, self.param[i - 1])
            elif r < 0.45:
                i = random.randint(1, 4)
                self.evento(15, i, self.param[i - 1], round(self.limiti[i - 1][1] * 1.3, 1))
            elif r < 0.6:
                self.quadro = not self.quadro
                self.evento(10 if self.quadro else 11)
            elif self.chk == self.rif:
                self.chk = os.urandom(8)
                self.evento(3, extra=int.from_bytes(self.chk[:4], "big"))
                self.bloccato = True
                self.evento(6)
            else:
                self.rif = bytes(self.chk)
                self.bloccato = False
                self.evento(2, extra=int.from_bytes(self.chk[:4], "big"))
        stato = 1 | (2 if self.chk == self.rif else 0) | 4 | (8 if self.bloccato else 0) | 32
        struct.pack_into(">iih", self.b, 0, self.vita, self.seq, self.idx)
        self.b[12] = stato
        self.b[22:30], self.b[30:38] = self.rif, self.chk
        for n, (mn, mx, att) in enumerate(self.limiti):
            struct.pack_into(">ffB", self.b, OFF_LIMITI + n * 10, mn, mx, 1 if att else 0)
            struct.pack_into(">f", self.b, OFF_PARAM + n * 4, self.param[n])
        self.b[OFF_HW] = 1 if self.quadro else 0
        for n, nome in enumerate(["sew-movimot-1", "tbn-ll-8iol"], 1):
            o = OFF_PN_NOMI + (n - 1) * 26
            self.b[o], self.b[o + 1] = 24, len(nome)
            self.b[o + 2:o + 2 + len(nome)] = nome.encode()
        self.b[OFF_PN_CFG] = 0b00000110            # dispositivi PROFINET 1 e 2 configurati
        self.b[OFF_PN_PRES] = 0b00000010           # solo il n. 1 presente
        struct.pack_into(">HH", self.b, OFF_ETH, 0b11, 0b01)   # Ethernet 1 e 2 controllati, 1 online
        return bytearray(self.b)

    def scrivi(self, offset, dati):
        self.b[offset:offset + len(dati)] = dati

    def descrizione(self):
        return "Simulatore (nessun PLC collegato)"


# ------------------------------------------------------------------ registro a catena di hash
SCHEMA = """
CREATE TABLE IF NOT EXISTS registro (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts_reg TEXT NOT NULL, ts_plc TEXT, fonte TEXT NOT NULL,
    tipo TEXT NOT NULL, livello TEXT NOT NULL, seq_plc INTEGER, descrizione TEXT NOT NULL,
    dati TEXT NOT NULL, hash_prec TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stato (k TEXT PRIMARY KEY, v TEXT);
CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON registro BEGIN SELECT RAISE(ABORT, 'modifica non consentita'); END;
CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON registro BEGIN SELECT RAISE(ABORT, 'cancellazione non consentita'); END;
"""


def calcola_hash(prec, ts_reg, ts_plc, fonte, tipo, seq, descrizione, dati):
    # stesso formato del verificatore offline (static/verifica.html)
    testo = "|".join([prec, ts_reg, ts_plc or "", fonte, tipo, str(seq or ""), descrizione, dati])
    return hashlib.sha256(testo.encode("utf-8")).hexdigest()


class Registro:
    def __init__(self, percorso):
        self.percorso, self.lock = percorso, threading.Lock()
        with self._c() as c:
            c.executescript(SCHEMA)

    def _c(self):
        c = sqlite3.connect(self.percorso, timeout=10)
        c.row_factory = sqlite3.Row
        return c

    def get(self, k, default=None):
        with self._c() as c:
            r = c.execute("SELECT v FROM stato WHERE k=?", (k,)).fetchone()
            return json.loads(r["v"]) if r else default

    def set(self, k, v):
        with self.lock, self._c() as c:
            c.execute("INSERT INTO stato VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))

    def aggiungi(self, fonte, tipo, livello, descrizione, dati=None, ts_plc=None, seq=None):
        dati = json.dumps(dati or {}, sort_keys=True, ensure_ascii=False)
        with self.lock, self._c() as c:
            r = c.execute("SELECT hash FROM registro ORDER BY id DESC LIMIT 1").fetchone()
            prec, ts = (r["hash"] if r else GENESI), adesso()
            h = calcola_hash(prec, ts, ts_plc, fonte, tipo, seq, descrizione, dati)
            c.execute("INSERT INTO registro(ts_reg,ts_plc,fonte,tipo,livello,seq_plc,descrizione,dati,hash_prec,hash) "
                      "VALUES(?,?,?,?,?,?,?,?,?,?)", (ts, ts_plc, fonte, tipo, livello, seq, descrizione, dati, prec, h))

    def eventi(self, limite=200, crescente=False):
        with self._c() as c:
            return [dict(r) for r in c.execute(
                "SELECT * FROM registro ORDER BY id " + ("ASC" if crescente else "DESC") + " LIMIT ?", (limite,))]

    def verifica(self):
        prec, n = GENESI, 0
        with self._c() as c:
            for r in c.execute("SELECT * FROM registro ORDER BY id"):
                n += 1
                if r["hash_prec"] != prec or r["hash"] != calcola_hash(prec, r["ts_reg"], r["ts_plc"], r["fonte"], r["tipo"],
                                                                       r["seq_plc"], r["descrizione"], r["dati"]):
                    return {"integro": False, "voci": n, "prima_voce_alterata": r["id"],
                            "messaggio": f"Catena interrotta alla voce {r['id']}: il registro e' stato alterato."}
                prec = r["hash"]
        return {"integro": True, "voci": n, "ultimo_hash": prec, "messaggio": f"Registro integro: {n} voci verificate."}

    def esporta(self, cartella):
        Path(cartella).mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = Path(cartella) / f"sigillo_copia_{stamp}.jsonl"
        with open(dest, "w", encoding="utf-8") as f:
            for r in self.eventi(limite=10_000_000, crescente=True):
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        v = self.verifica()
        ancora = {"data": adesso(), "voci": v["voci"], "ultimo_hash": v.get("ultimo_hash"), "file": dest.name}
        (Path(cartella) / f"sigillo_ancora_{stamp}.json").write_text(json.dumps(ancora, indent=2))
        verificatore = Path(__file__).parent / "static" / "verifica.html"
        if verificatore.exists():
            (Path(cartella) / "verifica_registro.html").write_bytes(verificatore.read_bytes())
        return {"file": str(dest), "ancora": ancora}


# ------------------------------------------------------------------ servizio di lettura
class Servizio:
    def __init__(self, cfg, src, reg):
        self.cfg, self.src, self.reg = cfg, src, reg
        self.connesso, self.ultima_lettura, self.stato = None, None, {}
        self.rete = self.syslog = None      # controlli dei collegamenti (modulo collegamenti.py)
        self.ultimo_buf = None              # ultimo DB letto: nomi e IP per descrivere gli eventi
        self.eth_pannello = reg.get("eth_pannello", [])        # elenco Ethernet comunicato dal pannello
        self.vita_ferma, self.vita_segnalata = 0, False
        # stato della CPU: modo letto con snap7, differenza tra l'orologio della CPU e quello di questo PC
        self.cpu = {"modo": None, "szl_bzu": None, "errore_modo": None, "differenza_ora_s": None,
                    "ora_errata": reg.get("ora_cpu_errata", False)}

    def sistema(self, tipo, livello, testo, dati=None):
        self.reg.aggiungi("registratore", tipo, livello, testo, dati)

    def ciclo(self):
        try:
            buf = self.src.leggi()
            d = decodifica(buf)
            self.ultimo_buf = buf
        except Exception as ex:
            if self.connesso is not False:
                self.sistema("COMUNICAZIONE_PERSA", "attenzione", "Comunicazione con il PLC persa", {"errore": str(ex)[:200]})
            self.connesso = False
            return
        if self.connesso is False:
            self.sistema("COMUNICAZIONE_OK", "info", "Comunicazione con il PLC ripristinata")
        self.connesso, self.ultima_lettura = True, adesso()
        modo = self.controlla_modo()

        vita_prec = self.reg.get("vita")
        if vita_prec is not None and d["vita"] == vita_prec:
            self.vita_ferma += 1
            # in STOP il contatore e' fermo per forza: basta l'evento CPU_STOP
            if self.vita_ferma >= self.cfg["vita_ferma_dopo_letture"] and not self.vita_segnalata and modo != "STOP":
                self.sistema("VITA_FERMA", "allarme", "FB_SigilloBase non in esecuzione (CPU in RUN)" if modo == "RUN"
                             else "FB_SigilloBase non in esecuzione o CPU in STOP")
                self.vita_segnalata = True
        else:
            if self.vita_segnalata:
                self.sistema("VITA_OK", "info", "FB_SigilloBase di nuovo in esecuzione")
            self.vita_ferma, self.vita_segnalata = 0, False
            if vita_prec is not None:
                self.controlla_ora(d["cpu"])          # l'ora nel DB e' aggiornata solo mentre il FB gira
        self.reg.set("vita", d["vita"])

        ultimo = self.reg.get("ultimo_seq", 0)
        if d["seq_ultimo"] < ultimo:
            self.sistema("SEQ_AZZERATA", "attenzione", "Numerazione eventi del PLC ripartita da zero (DB reinizializzato)",
                         {"seq_registrato": ultimo, "seq_plc": d["seq_ultimo"]})
            ultimo = 0
        nuovi = [e for e in d["eventi"] if e["seq"] > ultimo]
        if nuovi and ultimo > 0 and nuovi[0]["seq"] > ultimo + 1:
            self.sistema("EVENTI_PERSI", "allarme", f"Eventi persi: dal n. {ultimo + 1} al n. {nuovi[0]['seq'] - 1} "
                                                   "(buffer del PLC sovrascritto mentre il registratore non leggeva)")
        for e in nuovi:
            codice, livello, testo = TIPI.get(e["tipo"], (f"TIPO_{e['tipo']}", "attenzione", f"Evento {e['tipo']}"))
            nome = self.cfg["parametri"].get(str(e["indice"]), f"Parametro {e['indice']}")
            if e["tipo"] == 1 and e["val_nuovo"] >= 1:
                testo += f" (avvio n. {int(e['val_nuovo'])})"
            elif e["tipo"] in (2, 3, 4):
                testo += f" (checksum {e['extra']:08X}...)"
            elif e["tipo"] == 14:
                testo = f"{nome}: {e['val_prec']:g} -> {e['val_nuovo']:g}"
            elif e["tipo"] == 15:
                testo = f"{nome}: valore {e['val_nuovo']:g} rifiutato, mantenuto {e['val_prec']:g}"
            elif e["tipo"] == 16:
                testo = (f"Limiti di {nome}: {e['val_prec']:g} - {e['val_nuovo']:g} "
                         f"({'attivi' if e['extra'] else 'disattivati'})")
            elif e["tipo"] == 9:
                testo += f": firmware {d['cpu_fw'] or '-'}, seriale {d['cpu_seriale'] or '-'}"
            elif e["tipo"] == 17:
                testo += f" (STATUS {e['extra']:04X})"
            elif e["tipo"] in (18, 19):
                n = nome_pn(self.ultimo_buf, e["indice"]) or self.cfg["nomi_profinet"].get(str(e["indice"]), f"dispositivo n. {e['indice']}")
                testo = f"PROFINET {n} {'offline' if e['tipo'] == 18 else 'di nuovo online'}"
            elif e["tipo"] in (20, 21):
                r = self.riga_eth(e["indice"])
                n = (f"{r['nome'] or '-'} ({r['ip']})" if r else
                     self.cfg["nomi_ethernet"].get(str(e["indice"]), f"riga {e['indice']}"))
                testo = f"Ethernet {n} {'offline' if e['tipo'] == 20 else 'di nuovo online'} (controllo del pannello)"
            elif e["tipo"] == 26:
                testo = f"Nome del dispositivo PROFINET n. {e['indice']} non leggibile (STATUS {e['extra']:04X})"
            elif e["tipo"] == 5:
                testo += f" (nuova firma {e['extra']:08X})"
            elif e["tipo"] == 8:
                testo += f" (STATUS {e['extra']:04X})"
            self.reg.aggiungi("plc", codice, livello, testo, e, e["ts_plc"], e["seq"])
            ultimo = e["seq"]
        self.reg.set("ultimo_seq", ultimo)

        self.stato = {k: v for k, v in d.items() if k != "eventi"}
        chiave = {k: d[k] for k in ("versione", "checksum_att", "firma_f_att", "cpu_fw", "cpu_seriale")}
        if self.reg.get("inventario") != chiave:
            self.sistema("INVENTARIO", "info", "Software installato aggiornato", chiave)
            self.reg.set("inventario", chiave)


        ore, ultima = self.cfg.get("copia_ogni_ore") or 0, self.reg.get("ultima_copia")
        if ore and (ultima is None or time.time() - ultima > ore * 3600):
            try:
                self.reg.esporta(self.cfg["cartella_copie"])
                self.reg.set("ultima_copia", time.time())
            except OSError as ex:
                self.sistema("COPIA_FALLITA", "attenzione", "Copia periodica non riuscita", {"errore": str(ex)})

    # -------------------------------------------------------------- stato della CPU
    def controlla_modo(self):
        """Legge RUN/STOP dalla CPU e registra i passaggi. Restituisce il modo (None se non leggibile)."""
        leggi = getattr(self.src, "modo_cpu", None)
        if leggi is None:
            return None
        try:
            modo, bzu = leggi()
            self.cpu.update(modo=modo, szl_bzu=None if bzu is None else f"{bzu:02X}", errore_modo=None)
        except Exception as ex:
            self.cpu.update(modo=None, errore_modo=str(ex)[:200])
            return None
        prec = self.reg.get("cpu_modo")
        if modo in ("RUN", "STOP") and modo != prec:      # AVVIO e' un passaggio: non si registra
            if modo == "STOP":
                self.sistema("CPU_STOP", "allarme", "CPU in STOP", {"szl_bzu": self.cpu["szl_bzu"]})
            elif prec is not None:
                self.sistema("CPU_RUN", "info", "CPU di nuovo in RUN", {"szl_bzu": self.cpu["szl_bzu"]})
            self.reg.set("cpu_modo", modo)
        return modo

    def controlla_ora(self, cpu):
        """Confronta l'ora della CPU con quella di questo PC: se l'orologio della CPU e' sbagliato,
        anche le date che il PLC scrive negli eventi lo sono."""
        ora = dt.datetime.fromisoformat(cpu["ora"]) if cpu and cpu.get("ora") else None
        if ora is None:
            self.cpu["differenza_ora_s"] = None
            return
        diff = round((ora - dt.datetime.now()).total_seconds())
        self.cpu["differenza_ora_s"] = diff
        tolleranza = float(self.cfg.get("tolleranza_ora_s") or 60)
        dati = {"ora_cpu": cpu["ora"], "ora_pc": adesso(), "differenza_s": diff}
        if abs(diff) > tolleranza and not self.cpu["ora_errata"]:
            self.sistema("ORA_CPU_ERRATA", "attenzione",
                         f"Orologio della CPU {'avanti' if diff > 0 else 'indietro'} di {durata_testo(diff)} rispetto al "
                         "registratore: le date degli eventi del PLC sono sbagliate", dati)
            self.cpu["ora_errata"] = True
            self.reg.set("ora_cpu_errata", True)
        elif abs(diff) <= tolleranza / 2 and self.cpu["ora_errata"]:
            self.sistema("ORA_CPU_OK", "info", "Orologio della CPU di nuovo allineato al registratore", dati)
            self.cpu["ora_errata"] = False
            self.reg.set("ora_cpu_errata", False)

    def stato_cpu(self):
        """Stato della CPU per la pagina web e il pannello: modo da snap7 e dati scritti dal FB."""
        return dict(self.cpu, modo=self.cpu["modo"] if self.connesso else None,
                    vita_ferma=self.vita_ferma >= self.cfg["vita_ferma_dopo_letture"],
                    tolleranza_ora_s=self.cfg.get("tolleranza_ora_s"), **((self.stato or {}).get("cpu") or {}))

    # -------------------------------------------------------------- dati che arrivano dal pannello
    def riga_eth(self, r):
        return next((x for x in self.eth_pannello if x.get("riga") == r), None)

    def imposta_eth_pannello(self, righe):
        """Elenco Ethernet salvato nel pannello: serve per dare un nome agli eventi 20/21."""
        pulite = []
        for x in righe[:16]:
            try:
                pulite.append({"riga": int(x["riga"]), "ip": str(x["ip"])[:15], "porta": int(x.get("porta", 0)),
                               "nome": str(x.get("nome", ""))[:16]})
            except (KeyError, TypeError, ValueError):
                continue
        if pulite != self.eth_pannello:
            prima = {(x["ip"], x["nome"]) for x in self.eth_pannello}
            dopo = {(x["ip"], x["nome"]) for x in pulite}
            self.eth_pannello = pulite
            self.reg.set("eth_pannello", pulite)
            self.sistema("ETHERNET_ELENCO", "info", "Elenco dei dispositivi Ethernet del pannello aggiornato",
                         {"aggiunti": sorted(f"{n} {i}" for i, n in dopo - prima),
                          "tolti": sorted(f"{n} {i}" for i, n in prima - dopo)})

    def commenti(self):
        return self.reg.get("commenti_macchina", {})       # "pn:3" -> testo, "eth:192.168.0.11" -> testo

    def commenta(self, chiave, testo, chi):
        c = self.commenti()
        if testo:
            c[chiave] = testo[:40]
        else:
            c.pop(chiave, None)
        self.reg.set("commenti_macchina", c)
        self.sistema("COMMENTO", "info", f"Commento di {chiave.replace('pn:', 'PROFINET n. ').replace('eth:', 'Ethernet ')} "
                                         f"impostato da {chi}: \"{testo[:40] or '(vuoto)'}\"", {"chiave": chiave, "chi": chi})

    def macchina(self):
        """Dispositivi della macchina con nomi e commenti: PROFINET dal PLC, Ethernet dal pannello."""
        c, st = self.commenti(), self.stato or {}
        pn = [dict(x, commento=c.get(f"pn:{x['n']}", "")) for x in st.get("profinet", [])]
        stato_eth = {x["n"]: x["online"] for x in st.get("ethernet", [])}
        eth = [dict(r, controllato=r["riga"] in stato_eth, online=stato_eth.get(r["riga"], False),
                    commento=c.get(f"eth:{r['ip']}", "")) for r in self.eth_pannello]
        return {"profinet": pn, "ethernet": eth}

    def esegui(self):
        self.sistema("REGISTRATORE_AVVIATO", "info", "Registratore avviato", {"sorgente": self.src.descrizione()})
        while True:
            self.ciclo()
            time.sleep(self.cfg["periodo_lettura_s"])


# ------------------------------------------------------------------ report PDF
def crea_report(cfg, reg, stato, destinazione):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    st = getSampleStyleSheet()
    p = st["BodyText"].clone("p", fontSize=7.5, leading=9)
    v = reg.verifica()
    s = stato or {}
    inv = Table([[Paragraph(a, p), Paragraph(str(b), p)] for a, b in [
        ("Versione progetto", s.get("versione", "-")), ("Checksum approvato / attuale",
         f"{s.get('checksum_rif', '-')} / {s.get('checksum_att', '-')}"),
        ("Firma F approvata / attuale", f"{s.get('firma_f_rif', '-')} / {s.get('firma_f_att', '-')}"),
        ("CPU approvata / attuale", f"{s.get('cpu_fw_rif', '-')} {s.get('cpu_seriale_rif', '')} / "
                                    f"{s.get('cpu_fw', '-')} {s.get('cpu_seriale', '')}")]],
        colWidths=[60 * mm, 200 * mm])
    inv.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.grey)]))
    righe_par = [["N.", "Parametro", "Valore", "Minimo", "Massimo"]] + [
        [l["n"], cfg["parametri"].get(str(l["n"]), f"Parametro {l['n']}"), f"{l['valore']:g}",
         f"{l['min']:g}" if l["attivo"] else "-", f"{l['max']:g}" if l["attivo"] else "-"] for l in s.get("parametri", [])]
    par = Table(righe_par, colWidths=[12 * mm, 110 * mm, 30 * mm, 30 * mm, 30 * mm], repeatRows=1)
    par.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 7.5), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                             ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDE3E8"))]))
    righe = [["N.", "Registrato", "Ora PLC", "Fonte", "Descrizione"]] + [
        [e["id"], e["ts_reg"][:19].replace("T", " "), (e["ts_plc"] or "")[:19].replace("T", " "), e["fonte"],
         Paragraph(e["descrizione"], p)] for e in reg.eventi(limite=100000, crescente=True)]
    ev = Table(righe, colWidths=[12 * mm, 36 * mm, 36 * mm, 26 * mm, 160 * mm], repeatRows=1)
    ev.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 7.5), ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDE3E8")), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    SimpleDocTemplate(destinazione, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm,
                      topMargin=12 * mm, bottomMargin=12 * mm).build([
        Paragraph(f"Registro modifiche software - {cfg['macchina']}", st["Title"]),
        Paragraph(f"Matricola: {cfg.get('matricola') or '-'} &nbsp; Generato il {adesso()}", st["BodyText"]),
        Spacer(1, 3 * mm), Paragraph(f"<b>Integrita':</b> {v['messaggio']}", st["BodyText"]),
        Paragraph(f"Ultimo hash: {v.get('ultimo_hash', '-')}", p), Spacer(1, 3 * mm), inv, Spacer(1, 4 * mm),
        par, Spacer(1, 4 * mm), ev])
    return destinazione


# ------------------------------------------------------------------ web
def crea_app(cfg, reg, srv):
    import tempfile
    from fastapi import FastAPI, Form, HTTPException
    from fastapi.responses import FileResponse, JSONResponse
    app = FastAPI(title="Sigillo Base")
    statica = Path(__file__).parent / "static"

    @app.get("/")
    def home():
        return FileResponse(statica / "index.html")

    @app.get("/verifica")
    def pagina_verifica():
        return FileResponse(statica / "verifica.html")

    @app.get("/api/stato")
    def stato():
        return {"macchina": cfg["macchina"], "matricola": cfg.get("matricola", ""), "sorgente": srv.src.descrizione(),
                "connesso": srv.connesso, "ultima_lettura": srv.ultima_lettura, "stato": srv.stato,
                "nomi_parametri": cfg["parametri"], "nomi_profinet": cfg["nomi_profinet"],
                "nomi_ethernet": cfg["nomi_ethernet"], "macchina": srv.macchina(), "cpu": srv.stato_cpu()}

    @app.get("/api/collegamenti")
    def collegamenti():
        r, sl = srv.rete, srv.syslog
        return {
            "rete": None if r is None else {"sottoreti": r.sottoreti(), "ultima_scansione": r.ultima,
                                            "risposte_ultima_scansione": r.trovati_ultima,
                                            "questo_pc": r.locali_in_rete(), "errore": r.errore,
                                            "dispositivi": r.elenco()},
            "syslog": None if sl is None else {"porta": sl.cfg.get("porta", 514), "errore": sl.errore,
                                               "accesso_recente": sl.accesso_recente(), "ultimi": sl.ultimi[:20]},
            "pin_impostato": bool(cfg.get("pin_dispositivi")),
        }

    def controlla_pin(pin, azione):
        import hmac
        atteso = str(cfg.get("pin_dispositivi") or "")
        if not atteso:
            raise HTTPException(403, "Imposta \"pin_dispositivi\" in config.json per approvare dalla pagina web")
        if not hmac.compare_digest(str(pin or ""), atteso):
            reg.aggiungi("registratore", "PIN_ERRATO", "allarme", f"PIN errato per {azione} dalla pagina web")
            time.sleep(2)
            raise HTTPException(401, "PIN errato: il tentativo e' stato registrato")

    @app.post("/api/dispositivi/approva")
    def approva(ip: str = Form(...), nome: str = Form(""), chi: str = Form(""), pin: str = Form("")):
        if srv.rete is None:
            raise HTTPException(409, "Controllo della rete non attivo")
        controlla_pin(pin, f"approvare {ip}")
        srv.rete.approva(ip, nome.strip() or None, (chi.strip() or "pagina web")[:40])
        return {"ok": True}

    @app.post("/api/commento")
    def commenta(tipo: str = Form(...), indice: int = Form(0), ip: str = Form(""), testo: str = Form(""),
                 chi: str = Form(""), pin: str = Form("")):
        """Commento su un dispositivo: rete (approvato, per IP), PROFINET (per numero), Ethernet (per IP)."""
        testo, chi = testo.strip()[:40], (chi.strip() or "pagina web")[:40]
        controlla_pin(pin, f"commentare {tipo} {ip or indice}")
        return esegui_commento(tipo, indice, ip, testo, chi)

    def esegui_commento(tipo, indice, ip, testo, chi):
        if tipo == "rete":
            if srv.rete is None or not srv.rete.commenta(ip, testo, chi):
                raise HTTPException(404, "Solo i dispositivi approvati della rete si possono commentare")
        elif tipo == "profinet" and 1 <= indice <= 127:
            srv.commenta(f"pn:{indice}", testo, chi)
        elif tipo == "ethernet" and ip:
            srv.commenta(f"eth:{ip}", testo, chi)
        else:
            raise HTTPException(400, "tipo, indice o ip non validi")
        return {"ok": True}

    # ---------------------------------------------------------- API per il pannello Weintek (token)
    def controlla_token(token):
        import hmac
        atteso = str(cfg.get("token_pannello") or "")
        if not atteso:
            raise HTTPException(403, "API del pannello disattivata: imposta token_pannello in config.json")
        if not hmac.compare_digest(str(token or ""), atteso):
            reg.aggiungi("registratore", "TOKEN_ERRATO", "allarme", "Richiesta dal pannello con token errato")
            raise HTTPException(401, "token errato")

    @app.get("/api/pannello")
    def pannello(token: str = ""):
        """Tutto cio' che serve al JS Object, in un'unica risposta compatta."""
        controlla_token(token)
        r, sl = srv.rete, srv.syslog
        elenco = r.elenco() if r else []
        return {"ok": True, "ora": adesso(), "rete_attiva": r is not None, "errore_rete": r.errore if r else None,
                "rete": [{k: d[k] for k in ("ip", "nome", "mac", "online", "noto", "commento", "locale")} for d in elenco],
                "esterni": sum(1 for d in elenco if not d["noto"]),
                "noti_offline": sum(1 for d in elenco if d["noto"] and not d["online"]),
                "accesso_cpu": bool(sl and sl.accesso_recente()), "commenti": srv.commenti(),
                "cpu": {"modo": srv.stato_cpu()["modo"], "differenza_ora_s": srv.cpu["differenza_ora_s"]}}

    @app.post("/api/pannello/approva")
    def pannello_approva(token: str = Form(""), ip: str = Form(...), nome: str = Form("")):
        controlla_token(token)
        if srv.rete is None:
            raise HTTPException(409, "Controllo della rete non attivo")
        srv.rete.approva(ip, nome.strip() or None, "pannello HMI")
        return {"ok": True}

    @app.post("/api/pannello/revoca")
    def pannello_revoca(token: str = Form(""), ip: str = Form(...)):
        controlla_token(token)
        if srv.rete is None:
            raise HTTPException(409, "Controllo della rete non attivo")
        return {"ok": srv.rete.revoca(ip, "pannello HMI")}

    @app.post("/api/pannello/commento")
    def pannello_commento(token: str = Form(""), tipo: str = Form(...), indice: int = Form(0), ip: str = Form(""),
                          testo: str = Form("")):
        controlla_token(token)
        return esegui_commento(tipo, indice, ip, testo.strip()[:40], "pannello HMI")

    @app.post("/api/pannello/ethernet")
    def pannello_ethernet(token: str = Form(""), righe: str = Form("[]")):
        controlla_token(token)
        try:
            srv.imposta_eth_pannello(json.loads(righe))
        except ValueError:
            raise HTTPException(400, "elenco non valido")
        return {"ok": True}

    @app.post("/api/dispositivi/revoca")
    def revoca(ip: str = Form(...), chi: str = Form(""), pin: str = Form("")):
        if srv.rete is None:
            raise HTTPException(409, "Controllo della rete non attivo")
        controlla_pin(pin, f"revocare {ip}")
        return {"ok": srv.rete.revoca(ip, (chi.strip() or "pagina web")[:40])}

    @app.get("/api/eventi")
    def eventi(limite: int = 300):
        return reg.eventi(limite=min(limite, 2000))

    @app.get("/api/verifica")
    def verifica():
        return reg.verifica()

    @app.post("/api/esporta")
    def esporta():
        try:
            return reg.esporta(cfg["cartella_copie"])
        except OSError as ex:
            return JSONResponse({"errore": str(ex)}, status_code=500)

    @app.get("/api/report.pdf")
    def report():
        f = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        f.close()
        crea_report(cfg, reg, srv.stato, f.name)
        return FileResponse(f.name, media_type="application/pdf",
                            filename=f"registro_{cfg['macchina'].replace(' ', '_')}_{dt.date.today()}.pdf")
    return app


def main():
    ap = argparse.ArgumentParser(description="Sigillo Base - registratore")
    ap.add_argument("comando", choices=["avvia", "verifica", "report", "esporta"])
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--simula", action="store_true")
    ap.add_argument("--out", default="registro_sigillo.pdf")
    a = ap.parse_args()
    percorso = Path(a.config).resolve()
    if percorso.exists():
        os.chdir(percorso.parent)
    cfg = carica_config(str(percorso))
    reg = Registro(cfg["registro"])
    if a.comando == "verifica":
        r = reg.verifica()
        print(r["messaggio"])
        raise SystemExit(0 if r["integro"] else 2)
    if a.comando == "report":
        print("Report creato:", crea_report(cfg, reg, None, a.out))
        return
    if a.comando == "esporta":
        print(json.dumps(reg.esporta(cfg["cartella_copie"]), indent=2, ensure_ascii=False))
        return
    srv = Servizio(cfg, SorgenteSimulata() if a.simula else SorgentePLC(cfg), reg)
    import collegamenti
    srv.rete, srv.syslog = collegamenti.avvia(cfg, reg)
    threading.Thread(target=srv.esegui, daemon=True).start()
    import uvicorn
    print(f"Sigillo Base: apri http://localhost:{cfg['web']['porta']}")
    uvicorn.run(crea_app(cfg, reg, srv), host=cfg["web"]["host"], port=cfg["web"]["porta"], log_level="warning")


if __name__ == "__main__":
    main()
