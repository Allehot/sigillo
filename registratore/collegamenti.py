"""
Sigillo Base - rilevamento dei collegamenti alla macchina.

1. ControlloRete: scopre i dispositivi presenti sulla rete macchina (un pacchetto UDP a ogni
   indirizzo della sottorete, poi lettura della tabella ARP), segnala quelli non approvati e
   registra quando i dispositivi approvati vanno offline e tornano online. Un PC con TIA Portal collegato alla rete macchina compare qui
   anche se il suo firewall blocca il ping: alla richiesta ARP rispondono tutti.
2. RicevitoreSyslog: riceve i messaggi Syslog (UDP) inviati dalla CPU, se il modello li supporta,
   e li registra. I messaggi di accesso (login, sessione, connessione) accendono "AccessoCpu".
"""
import ipaddress
import platform
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

RE_IP = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")
RE_MAC = re.compile(r"\b([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})\b")
PAROLE_ACCESSO = ("login", "logon", "log on", "session", "sessione", "connect", "connession",
                  "password", "access level", "livello di accesso", "authentic")


def normalizza_mac(mac):
    return mac.replace("-", ":").upper()


def leggi_tabella_arp(testo):
    """Estrae le coppie IP -> MAC dall'uscita di 'arp -a' (Windows) o 'ip neigh' / 'arp -an' (Linux)."""
    tabella = {}
    for riga in testo.splitlines():
        ip, mac = RE_IP.search(riga), RE_MAC.search(riga)
        if ip and mac:
            m = normalizza_mac(mac.group(1))
            if m not in ("FF:FF:FF:FF:FF:FF", "00:00:00:00:00:00") and not m.startswith("01:00:5E"):
                tabella[ip.group(1)] = m
    return tabella


class ScannerSistema:
    """Scopre i dispositivi della sottorete senza librerie esterne ne' privilegi di amministratore.

    1. Invia un piccolo pacchetto UDP a ogni indirizzo: per spedirlo il sistema deve prima conoscere
       il MAC del destinatario, quindi fa una richiesta ARP. Rispondono tutti i dispositivi accesi,
       anche quelli con il firewall che blocca il ping.
    2. Legge la tabella ARP: /proc/net/arp su Linux, il comando "arp -a" su Windows.
    """

    def __init__(self, attesa_s=1.5):
        self.windows = platform.system() == "Windows"
        self.attesa_s = attesa_s

    def sonda(self, indirizzi):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setblocking(False)
        for ip in indirizzi:
            try:
                sock.sendto(b"\x00", (ip, 9))           # porta 9 = "discard": nessun servizio risponde
            except OSError:
                pass
        sock.close()

    def tabella(self):
        if not self.windows and Path("/proc/net/arp").exists():
            return Path("/proc/net/arp").read_text(errors="replace")
        cmd = ["arp", "-a"] if self.windows else ["arp", "-an"]
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10, errors="replace",
                              creationflags=0x08000000 if self.windows else 0).stdout

    def scansiona(self, sottorete):
        rete = ipaddress.ip_network(sottorete, strict=False)
        self.sonda([str(h) for h in rete.hosts()])
        time.sleep(self.attesa_s)                         # tempo per le risposte ARP
        return {ip: mac for ip, mac in leggi_tabella_arp(self.tabella()).items() if ipaddress.ip_address(ip) in rete}


def indirizzi_locali():
    """Gli indirizzi IP di questo PC (il registratore non segnala se stesso)."""
    ip = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip.add(info[4][0])
    except OSError:
        pass
    return ip


def durata(secondi):
    secondi = int(secondi)
    if secondi < 120:
        return f"{secondi} s"
    if secondi < 7200:
        return f"{secondi // 60} min"
    return f"{secondi // 3600} h {secondi % 3600 // 60} min"


class ControlloRete:
    """Tiene l'elenco dei dispositivi della rete macchina e ne registra i cambiamenti.

    - Dispositivi NOTI: approvati dalla pagina web o dal pannello, salvati nel registro.
      Per ognuno si registra quando va offline e quando torna online.
    - Dispositivi NON NOTI: ogni comparsa e scomparsa viene registrata come allarme.
    Un dispositivo e' considerato offline dopo 3 scansioni consecutive senza risposta.
    """

    ASSENZE_OFFLINE = 3

    def __init__(self, cfg, registro, scanner=None):
        self.cfg = cfg["rete"]
        self.reg = registro
        self.scanner = scanner or ScannerSistema()
        self.lock = threading.Lock()
        self.locali = indirizzi_locali()
        self.stato = {}           # ip -> {"mac", "online", "dal" (inizio stato attuale), "assenze"}
        self.ultima = None
        self.errore = None
        self.trovati_ultima = 0
        self.primo_giro = True
        if self.reg.get("dispositivi_noti") is None:   # al primo avvio importa quelli di config.json
            noti = {}
            for ip, n in self.cfg.get("noti", {}).items():
                n = n if isinstance(n, dict) else {"nome": n}
                noti[ip] = {"nome": n.get("nome", ip)[:16], "mac": normalizza_mac(n.get("mac") or ""),
                            "approvato_da": "config.json", "data": time.strftime("%Y-%m-%dT%H:%M:%S")}
            self.reg.set("dispositivi_noti", noti)

    def sottoreti(self):
        r = self.cfg.get("sottoreti") or self.cfg.get("sottorete") or []
        return [r] if isinstance(r, str) else list(r)

    def locali_in_rete(self):
        """Indirizzi di questo PC che stanno nelle sottoreti controllate."""
        reti = [ipaddress.ip_network(x, strict=False) for x in self.sottoreti()]
        return sorted(ip for ip in self.locali if any(ipaddress.ip_address(ip) in r for r in reti))

    # -------------------------------------------------------------- elenco dei noti
    def noti(self):
        return self.reg.get("dispositivi_noti", {})

    def approva(self, ip, nome, chi):
        with self.lock:
            noti = self.noti()
            mac = self.stato.get(ip, {}).get("mac", "")
            nome = (nome or f"Dispositivo {ip.split('.')[-1]}")[:16]
            noti[ip] = {"nome": nome, "mac": mac, "approvato_da": chi, "data": time.strftime("%Y-%m-%dT%H:%M:%S")}
            self.reg.set("dispositivi_noti", noti)
        self.reg.aggiungi("registratore", "DISPOSITIVO_APPROVATO", "info",
                          f"Dispositivo approvato da {chi}: {nome} ({ip}, MAC {mac or '-'})",
                          {"ip": ip, "mac": mac, "nome": nome, "chi": chi})

    def commenta(self, ip, testo, chi):
        """Commento libero su un dispositivo approvato (es. "telecamera linea 2, sostituita 03/2027")."""
        with self.lock:
            noti = self.noti()
            if ip not in noti:
                return False
            noti[ip]["commento"] = testo[:40]
            self.reg.set("dispositivi_noti", noti)
        self.reg.aggiungi("registratore", "COMMENTO_RETE", "info",
                          f"Commento di {noti[ip]['nome']} ({ip}) impostato da {chi}: \"{testo[:40]}\"",
                          {"ip": ip, "chi": chi})
        return True

    def revoca(self, ip, chi):
        with self.lock:
            noti = self.noti()
            d = noti.pop(ip, None)
            self.reg.set("dispositivi_noti", noti)
        if d:
            self.reg.aggiungi("registratore", "DISPOSITIVO_REVOCATO", "attenzione",
                              f"Approvazione revocata da {chi}: {d['nome']} ({ip})", {"ip": ip, "chi": chi})
        return d is not None

    # -------------------------------------------------------------- scansione
    def ciclo(self):
        try:
            trovati = {}
            for rete in self.sottoreti():
                trovati.update(self.scanner.scansiona(rete))
            self.errore = None
        except Exception as ex:  # rete non disponibile: si riprova al giro successivo
            if self.errore is None:
                self.reg.aggiungi("registratore", "RETE_ERRORE", "attenzione", "Scansione della rete macchina non riuscita",
                                  {"errore": str(ex)[:200]})
            self.errore = str(ex)
            return
        ora = time.time()
        self.ultima = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.trovati_ultima = len(trovati)
        for ip in self.locali:
            trovati.pop(ip, None)          # il PC del registratore compare a parte, come "questo PC"
        noti = self.noti()

        with self.lock:
            # dispositivi che rispondono
            for ip, mac in trovati.items():
                st = self.stato.get(ip)
                noto = noti.get(ip)
                if st is None or not st["online"]:
                    offline_da = None if st is None else ora - st["dal"]
                    self.stato[ip] = {"mac": mac, "online": True, "dal": ora, "assenze": 0}
                    if noto is None:
                        self.reg.aggiungi("registratore", "DISPOSITIVO_ESTERNO", "allarme",
                                          f"Dispositivo non noto collegato alla rete macchina: {ip} (MAC {mac})",
                                          {"ip": ip, "mac": mac})
                    elif not self.primo_giro:
                        dopo = f" dopo {durata(offline_da)} offline" if offline_da else ""
                        self.reg.aggiungi("registratore", "DISPOSITIVO_ONLINE", "info",
                                          f"{noto['nome']} ({ip}) di nuovo online{dopo}", {"ip": ip, "mac": mac})
                    if noto and noto.get("mac") and noto["mac"] != mac:
                        self.reg.aggiungi("registratore", "MAC_DIVERSO", "allarme",
                                          f"{noto['nome']} ({ip}) risponde con un MAC diverso da quello approvato: {mac}",
                                          {"ip": ip, "mac": mac, "mac_noto": noto["mac"]})
                else:
                    st["assenze"] = 0
                    st["mac"] = mac

            # dispositivi che non rispondono piu'
            for ip, st in list(self.stato.items()):
                if ip in trovati or not st["online"]:
                    continue
                st["assenze"] += 1
                if st["assenze"] >= self.ASSENZE_OFFLINE:
                    noto = noti.get(ip)
                    online_da = ora - st["dal"]
                    if noto:
                        st.update(online=False, dal=ora)
                        self.reg.aggiungi("registratore", "DISPOSITIVO_OFFLINE", "attenzione",
                                          f"{noto['nome']} ({ip}) offline (era online da {durata(online_da)})",
                                          {"ip": ip, "mac": st["mac"]})
                    else:
                        del self.stato[ip]
                        self.reg.aggiungi("registratore", "DISPOSITIVO_ESTERNO_RIMOSSO", "info",
                                          f"Dispositivo non noto scollegato dalla rete macchina: {ip} "
                                          f"(collegato per {durata(online_da)})", {"ip": ip, "mac": st["mac"]})

            # dispositivi noti mai visti dall'avvio: offline
            for ip in noti:
                if ip not in self.stato:
                    self.stato[ip] = {"mac": noti[ip].get("mac", ""), "online": False, "dal": ora, "assenze": 0}

            if self.primo_giro:
                on = [noti[ip]["nome"] for ip in noti if self.stato[ip]["online"]]
                off = [noti[ip]["nome"] for ip in noti if not self.stato[ip]["online"]]
                self.reg.aggiungi("registratore", "RETE_STATO_INIZIALE", "info" if not off else "attenzione",
                                  f"Dispositivi noti: {len(on)} online, {len(off)} offline"
                                  + (f" ({', '.join(off)})" if off else ""), {"online": on, "offline": off})
                self.primo_giro = False

    # -------------------------------------------------------------- elenco per pannello e pagina web
    def elenco(self):
        """Noti (online e offline) prima, poi i non noti; ordinati per indirizzo."""
        noti = self.noti()
        with self.lock:
            righe = []
            for ip, st in self.stato.items():
                n = noti.get(ip)
                if n is None and not st["online"]:
                    continue
                righe.append({"ip": ip, "mac": st["mac"], "online": st["online"], "noto": n is not None,
                              "nome": n["nome"] if n else "", "dal": time.strftime("%Y-%m-%dT%H:%M:%S",
                                                                                   time.localtime(st["dal"])),
                              "approvato_da": n.get("approvato_da", "") if n else "",
                              "commento": n.get("commento", "") if n else "", "locale": False})
            for ip in self.locali_in_rete():       # il PC del registratore: sempre noto e online
                righe.append({"ip": ip, "mac": "", "online": True, "noto": True, "nome": "Questo PC",
                              "dal": "", "approvato_da": "", "commento": "registratore Sigillo", "locale": True})
        righe.sort(key=lambda r: (not r["noto"], ipaddress.ip_address(r["ip"])))
        return righe

    def esterni(self):
        return [r["ip"] for r in self.elenco() if not r["noto"]]

    def noti_offline(self):
        return [r["ip"] for r in self.elenco() if r["noto"] and not r["online"]]

    def esegui(self):
        while True:
            self.ciclo()
            time.sleep(self.cfg.get("periodo_s", 15))


class RicevitoreSyslog:
    """Server Syslog UDP minimo: registra i messaggi delle sorgenti ammesse (la CPU)."""

    def __init__(self, cfg, registro):
        self.cfg = cfg["syslog"]
        self.reg = registro
        self.ultimo_accesso = 0.0
        self.ultimi = []           # ultimi messaggi per la pagina web
        self.errore = None
        self.sock = None

    def apri(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((self.cfg.get("indirizzo", "0.0.0.0"), int(self.cfg.get("porta", 514))))
        return self.sock.getsockname()[1]

    def accesso_recente(self):
        return time.time() - self.ultimo_accesso < self.cfg.get("accesso_minuti", 5) * 60

    def gestisci(self, dati, ip):
        sorgenti = self.cfg.get("sorgenti") or []
        if sorgenti and ip not in sorgenti:
            return
        testo = dati.decode("utf-8", "replace").strip()
        testo = re.sub(r"^<\d{1,3}>\s*", "", testo)[:1000]            # toglie la priorita' <PRI>
        accesso = any(p in testo.lower() for p in PAROLE_ACCESSO)
        if accesso:
            self.ultimo_accesso = time.time()
        self.ultimi = ([{"ora": time.strftime("%Y-%m-%dT%H:%M:%S"), "ip": ip, "testo": testo}] + self.ultimi)[:50]
        self.reg.aggiungi("cpu-syslog", "ACCESSO_CPU" if accesso else "SYSLOG_CPU",
                          "attenzione" if accesso else "info",
                          f"Messaggio di sicurezza dalla CPU {ip}: {testo[:300]}", {"ip": ip, "testo": testo})

    def esegui(self):
        try:
            if self.sock is None:
                self.apri()
        except OSError as ex:
            self.errore = f"porta {self.cfg.get('porta', 514)} non disponibile: {ex}"
            self.reg.aggiungi("registratore", "SYSLOG_ERRORE", "attenzione",
                              f"Ricevitore Syslog non avviato ({self.errore})")
            return
        while True:
            try:
                dati, (ip, _porta) = self.sock.recvfrom(8192)
                self.gestisci(dati, ip)
            except OSError:
                time.sleep(1)


def avvia(cfg, registro):
    """Avvia i controlli abilitati in config.json e li restituisce (None se disabilitati)."""
    rete = syslog = None
    if cfg.get("rete", {}).get("abilitato"):
        rete = ControlloRete(cfg, registro)
        threading.Thread(target=rete.esegui, daemon=True).start()
    if cfg.get("syslog", {}).get("abilitato"):
        syslog = RicevitoreSyslog(cfg, registro)
        threading.Thread(target=syslog.esegui, daemon=True).start()
    return rete, syslog
