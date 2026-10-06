/*
 * Sigillo Base v2.2 – JS Object per pannelli Weintek cMT-X (EasyBuilder Pro 6.05.02 o successivo)
 *
 * Il PLC contiene solo stato, eventi, parametri, hardware e dispositivi PROFINET.
 * L'elenco dei dispositivi Ethernet sta nella memoria del pannello; elenco della rete, MAC,
 * approvazioni e commenti stanno nel registratore, che il pannello interroga via HTTP.
 *
 * Scheda [Config] (Tipo = Tags). Indirizzi "assoluti": senza "Tag di progetto", 16-bit Unsigned.
 *   dbStato         assoluto, DB n byte 0,    Conteggio 35
 *   dbEst           assoluto, DB n byte 1094, Conteggio 135
 *   dbPn            assoluto, DB n byte 1364, Conteggio 229   (PROFINET e nomi)
 *   ethStato        assoluto, DB n byte 1396, Conteggio 3     (il pannello scrive lo stato Ethernet)
 *   dbCpu           assoluto, DB n byte 1822, Conteggio 17    (stato della CPU, facoltativo)
 *   dbEventi        assoluto, DB n byte 70,   Conteggio 512   (scheda Registro, facoltativo)
 *   ioIngressi      area ingressi (I), parola IW0, 16-bit Unsigned, Conteggio = parole indicate nella scheda I/O
 *   ioUscite        area uscite (Q), parola QW0, 16-bit Unsigned, Conteggio = parole indicate nella scheda I/O
 *                   (scheda I/O, facoltativi: si leggono dal byte 0 all'ultimo canale dei moduli in IO.moduli)
 *   ethMemoria      Local HMI, RW (es. RW-1000), 16-bit Unsigned, Conteggio 192 (elenco Ethernet, ritentivo)
 *   cmdApprova      tag DB_SigilloBase.Cmd.ImpostaRiferimento   Bit
 *   cmdSblocca      tag DB_SigilloBase.Cmd.SbloccaAvvio         Bit
 *   pnRileggi       tag DB_SigilloBase.PnCmd.Rileggi            Bit (facoltativo)
 *   cpuAzzera       tag DB_SigilloBase.Cpu.AzzeraCiclo          Bit (facoltativo)
 *   abilitaComandi  bit interno, es. LB-9000 (facoltativo): a 1 solo con amministratore loggato
 * Se il driver non legge un blocco lungo, dividilo in pezzi da 62 parole: campo2, campo3...
 * (es. dbPn2 dal byte 1488, dbPn3 dal 1612, dbPn4 dal 1736; dbEventi2 dal 194, ... dbEventi9 dal 1062).
 *
 * Carico sul pannello: ogni secondo si leggono solo dbStato e i primi 20 word di dbPn; il resto ogni
 * 10 s o quando la scheda aperta lo mostra. Il Canvas si ridisegna solo se qualcosa e' cambiato.
 *
 * RUN / STOP: il pannello lo deduce dal contatore di vita (fermo = CPU in STOP o FB non chiamato)
 * e lo riceve preciso dal registratore, che lo legge dalla CPU con snap7, quando e' raggiungibile.
 */
const self = this;

// ------------------------------------------------------------------ personalizzazione
const REGISTRATORE = { url: "http://192.168.0.50:8150", token: "cambia-questa-chiave" };   // url "" = nessun registratore
const NOMI_PARAMETRI = [
  "Velocità rulliera ingresso [m/min]", "Override massimo robot [%]", "Quota prelievo [mm]",
  "Tempo muting barriera [ms]", "Parametro 5", "Parametro 6", "Parametro 7", "Parametro 8",
  "Parametro 9", "Parametro 10", "Parametro 11", "Parametro 12", "Parametro 13", "Parametro 14",
  "Parametro 15", "Parametro 16",
];
// Scheda I/O: i moduli della macchina con gli indirizzi della Configurazione dispositivi di TIA.
// Digitali: area "I" o "Q", primo byte e numero di canali. Analogici: area "AI" o "AQ", indirizzo della
// prima parola, numero di canali e scala facoltativa (0..27648 = min..max). Non occupano nulla nel DB.
const IO = {
  moduli: [
    { nome: "CPU - ingressi digitali", area: "I", byte: 0, bit: 14 },
    { nome: "CPU - uscite digitali", area: "Q", byte: 0, bit: 10 },
    { nome: "CPU - ingressi analogici", area: "AI", indirizzo: 64, canali: 2, scala: { min: 0, max: 10, unita: "V" } },
    // { nome: "SM 1221 DI16", area: "I", byte: 8, bit: 16 },
  ],
  simboli: { "I0.0": "Fungo emergenza", "Q0.0": "Lampada rossa" },
};
const FONT = "Arial";
const SONDA_OGNI_MS = 5000, SONDA_TENTATIVI_OFFLINE = 3, REGISTRATORE_OGNI_MS = 5000;

// ------------------------------------------------------------------ costanti
// [campo, parole, byte di partenza]; i campi con numero sono facoltativi (lettura divisa)
function blocchi(campo, inizio, parole) {
  const out = [[campo, parole, inizio]];
  for (let k = 1; k * 62 < parole; k++) out.push([campo + (k + 1), Math.min(62, parole - k * 62), inizio + k * 124]);
  return out;
}
const BLOCCHI = { stato: blocchi("dbStato", 0, 35), est: blocchi("dbEst", 1094, 135), pn: blocchi("dbPn", 1364, 229),
                  cpu: blocchi("dbCpu", 1822, 17), eventi: blocchi("dbEventi", 70, 512) };
const COL = {
  fondo: "#E8ECEF", pannello: "#F8FAFB", inchiostro: "#15212B", tenue: "#56646F", riga: "#C9D1D8",
  petrolio: "#0A5F63", ok: "#1D7446", okFondo: "#E3F0E8", allarme: "#B3261E", allarmeFondo: "#F6E1DF",
  att: "#9A5B00", attFondo: "#FBEFD9", bianco: "#FFFFFF", velo: "rgba(21,33,43,0.55)",
};

const canvas = new Canvas();
const area = new MouseArea();
this.widget.add(canvas);
this.widget.add(area);
const W = canvas.width, H = canvas.height;

let stato = null, errore = null, vitaPrec = null, vitaFerma = 0, vitaMossa = false;
let dialogo = null, avviso = null, inAttesa = null, lettura = false, bottoni = [], scheda = "stato", vista = "macchina";
// elenco Ethernet (memoria del pannello) e stato del suo controllo
let ethRighe = [], ethLetto = false;
const eth = Array.from({ length: 16 }, () => ({ chiave: "", online: null, mancate: 0 }));
let ethVita = 0, sondaInCorso = false;
// dati del registratore
let reg = null, regUltimo = 0, regErrore = "", regInCorso = false, ultimoInvioEth = 0;

// ------------------------------------------------------------------ decodifica
function inByte(v) {
  const b = new Uint8Array(v.length * 2);
  v.forEach((w, i) => { b[2 * i] = (w >> 8) & 0xff; b[2 * i + 1] = w & 0xff; });
  return b;
}
function hex(b, o, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += (b[o + i] < 16 ? "0" : "") + b[o + i].toString(16).toUpperCase();
  return s;
}
function i32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
function i16(b, o) { return ((b[o] << 8) | b[o + 1]) << 16 >> 16; }
function f32(b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false); }
function stringa(b, o) {
  let s = "";
  for (let i = 0; i < Math.min(b[o + 1], b[o]); i++) s += String.fromCharCode(b[o + 2 + i]);
  return s.trim();
}
function firmware(b, o) {
  if (!b[o] && !b[o + 1] && !b[o + 2] && !b[o + 3]) return "";
  return (b[o] > 32 && b[o] < 127 ? String.fromCharCode(b[o]) : "V") + b[o + 1] + "." + b[o + 2] + "." + b[o + 3];
}
function numero(v) { return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toFixed(2); }

// Stato della CPU scritto dal FB (byte 1822..1855): tempi di ciclo, avvii, tempo dall'avvio.
// L'ora della CPU (byte 1834) non si mostra.
function decodificaCpu(c) {
  return { ciclo: f32(c, 0), cicloMin: f32(c, 4), cicloMax: f32(c, 8), avvii: i32(c, 24), secondiDaAvvio: i32(c, 28) };
}

// b: byte 0..69 · e: 1094..1363 · p: 1364..1821 (offset relativi)
function decodifica(b, e, p, abilitato) {
  const parametri = [];
  for (let n = 0; n < 16; n++) {
    parametri.push({ n: n + 1, min: f32(e, n * 10), max: f32(e, n * 10 + 4), attivo: (e[n * 10 + 8] & 1) === 1,
                     valore: f32(e, 160 + n * 4) });
  }
  const profinet = [];
  for (let n = 1; n < 128; n++) {
    if (!((p[n >> 3] >> (n & 7)) & 1)) continue;
    const nome = n <= 16 ? stringa(p, 40 + (n - 1) * 26) : "";
    const err = n <= 16 && ((p[456 + ((n - 1) >> 3)] >> ((n - 1) & 7)) & 1) === 1;
    profinet.push({ n: n, nome: nome || (err ? "nome non leggibile" : "dispositivo n. " + n),
                    online: ((p[16 + (n >> 3)] >> (n & 7)) & 1) === 1 });
  }
  const st = b[12];
  return {
    vita: i32(b, 0), seq: i32(b, 4),
    cmdApprova: (b[10] & 1) !== 0, cmdSblocca: (b[10] & 2) !== 0,
    riferimentoValido: (st & 1) !== 0, checksumOk: (st & 2) !== 0, firmaFOk: (st & 4) !== 0,
    avvioBloccato: (st & 8) !== 0, erroreLettura: (st & 16) !== 0, hwOk: (st & 32) !== 0,
    firmaFRif: hex(b, 14, 4), firmaFAtt: hex(b, 18, 4), checksumRif: hex(b, 22, 8), checksumAtt: hex(b, 30, 8),
    versione: stringa(b, 38), parametri: parametri,
    quadroAperto: (e[224] & 1) !== 0, manutenzione: (e[224] & 2) !== 0, erroreIM: (e[224] & 4) !== 0,
    cpuFw: firmware(e, 226), cpuFwRif: firmware(e, 230), cpuSeriale: stringa(e, 234), cpuSerialeRif: stringa(e, 252),
    profinet: profinet, abilitato: abilitato,
  };
}

// ------------------------------------------------------------------ lettura dal PLC
async function leggiCampo(nome, parole) {
  if (!self.config[nome]) throw new Error("campo '" + nome + "' non configurato nella scheda Config");
  try {
    const d = await driver.promises.getData(self.config[nome], parole);
    if (!d || !d.values || d.values.length < parole) throw new Error("ricevute meno parole del previsto");
    return d.values.slice(0, parole);
  } catch (err) {
    throw new Error(nome + " (" + parole + " parole): " + ((err && err.message) || err));
  }
}

// Legge un'area: in un blocco solo, oppure divisa se nella Config c'e' il secondo campo
async function leggiArea(blocchi) {
  if (blocchi.length > 1 && self.config[blocchi[1][0]]) {
    let v = [];
    for (let i = 0; i < blocchi.length; i++) {
      const parole = i === 0 ? (blocchi[1][2] - blocchi[0][2]) / 2 : blocchi[i][1];
      v = v.concat(await leggiCampo(blocchi[i][0], parole));
    }
    return inByte(v);
  }
  return inByte(await leggiCampo(blocchi[0][0], blocchi[0][1]));
}

// Ogni secondo si legge solo quello che cambia o che la scheda aperta mostra: stato (35 parole) e
// stato PROFINET (20). Parametri, nomi PROFINET e CPU si rileggono ogni LETTURA_LENTA cicli, oppure a
// ogni ciclo quando la scheda aperta li mostra.
const LETTURA_LENTA = 10;
let cicli = 0, forzaLettura = false, ultE = null, ultP = null, ultCpu = null, nomiPnFino = 0;
async function leggi() {
  if (lettura) return;
  lettura = true;
  try {
    const lenta = forzaLettura || cicli % LETTURA_LENTA === 0;
    forzaLettura = false;
    cicli += 1;
    const b = await leggiArea(BLOCCHI.stato);
    if (lenta || !ultE || scheda === "stato" || scheda === "parametri") ultE = await leggiArea(BLOCCHI.est);
    if (!self.config.dbPn) ultP = new Uint8Array(458);
    else if (lenta || !ultP || scheda === "dispositivi" && Date.now() < nomiPnFino) ultP = await leggiArea(BLOCCHI.pn);
    else ultP.set(inByte(await leggiCampo("dbPn", 20)));        // byte 0..39: configurati e presenti
    if (!self.config.dbCpu) ultCpu = null;
    else if (lenta || !ultCpu || scheda === "cpu") ultCpu = decodificaCpu(await leggiArea(BLOCCHI.cpu));
    await leggiEventi(b);
    if (scheda === "io") await leggiIo();
    let abilitato = true;
    if (self.config.abilitaComandi) abilitato = !!(await leggiCampo("abilitaComandi", 1))[0];
    stato = decodifica(b, ultE, ultP, abilitato);
    stato.cpu = ultCpu;
    vitaMossa = vitaPrec !== null && stato.vita !== vitaPrec;
    vitaFerma = vitaPrec !== null && stato.vita === vitaPrec ? vitaFerma + 1 : 0;
    vitaPrec = stato.vita;
    errore = null;
    controllaConferma();
  } catch (err) {
    errore = (err && err.message) || String(err);
  }
  lettura = false;
  disegna();
}

// Handshake con il PLC: il FB azzera il comando quando l'ha eseguito
function controllaConferma() {
  if (!inAttesa) return;
  const s = stato;
  const fatto = inAttesa.tipo === "approva" ? !s.cmdApprova && s.checksumOk : !s.cmdSblocca && !s.avvioBloccato;
  if (fatto) { avvisa(inAttesa.messaggio, false); inAttesa = null; }
  else if (Date.now() > inAttesa.fino) { avvisa("Il PLC non ha confermato il comando.", true); inAttesa = null; }
}

async function comandoPlc(tipo) {
  try {
    const campo = { approva: "cmdApprova", sblocca: "cmdSblocca", rileggi: "pnRileggi", azzera: "cpuAzzera" }[tipo];
    if (!self.config[campo]) throw new Error("campo " + campo + " non configurato");
    await driver.promises.setData(self.config[campo], [1]);
    if (tipo === "rileggi") { nomiPnFino = Date.now() + 60000; avvisa("Lettura dei nomi PROFINET avviata.", false); }
    else if (tipo === "azzera") avvisa("Tempo di ciclo minimo e massimo azzerati.", false);
    else {
      inAttesa = { tipo: tipo, fino: Date.now() + 20000,
                   messaggio: tipo === "approva" ? "Programma approvato." : "Avvio automatico sbloccato." };
      avvisa("Comando inviato, attendo conferma…", false);
    }
  } catch (err) {
    avvisa("Scrittura non riuscita: " + ((err && err.message) || err), true);
  }
  disegna();
}

function avvisa(testo, err) { avviso = { testo: testo, errore: err, fino: Date.now() + 6000 }; }

// ------------------------------------------------------------------ elenco Ethernet nella memoria del pannello
// 16 righe da 12 parole: IP (4 byte), porta, nome String[16] (lunghezza massima, lunghezza, 16 caratteri)
async function leggiMemoriaEth() {
  if (!self.config.ethMemoria) { ethLetto = true; return; }
  try {
    const m = inByte(await leggiCampo("ethMemoria", 192));
    const righe = [];
    for (let r = 1; r <= 16; r++) {
      const o = (r - 1) * 24;
      if (!m[o] && !m[o + 1] && !m[o + 2] && !m[o + 3]) continue;
      righe.push({ riga: r, ip: m[o] + "." + m[o + 1] + "." + m[o + 2] + "." + m[o + 3],
                   porta: (m[o + 4] << 8) | m[o + 5], nome: stringa(m, o + 6) });
    }
    ethRighe = righe;
    ethLetto = true;
    inviaElencoEth();
  } catch (err) {
    console.log("Sigillo: memoria del pannello non leggibile:", err);
  }
}

function paroleMemoriaEth(righe) {
  const m = new Uint8Array(384);
  righe.forEach(r => {
    const o = (r.riga - 1) * 24;
    r.ip.split(".").forEach((x, i) => { m[o + i] = +x; });
    m[o + 4] = (r.porta >> 8) & 0xff; m[o + 5] = r.porta & 0xff;
    const n = r.nome.slice(0, 16);
    m[o + 6] = 16; m[o + 7] = n.length;
    for (let i = 0; i < n.length; i++) m[o + 8 + i] = n.charCodeAt(i) & 0xff;
  });
  const parole = [];
  for (let i = 0; i < 384; i += 2) parole.push((m[i] << 8) | m[i + 1]);
  return parole;
}

async function salvaMemoriaEth(nuove, messaggio) {
  try {
    if (!self.config.ethMemoria) throw new Error("campo ethMemoria non configurato");
    await driver.promises.setData(self.config.ethMemoria, paroleMemoriaEth(nuove));
    ethRighe = nuove;
    avvisa(messaggio, false);
    inviaElencoEth(true);
    controllaEthernet();
  } catch (err) {
    avvisa("Elenco non salvato: " + ((err && err.message) || err), true);
  }
  disegna();
}

// ------------------------------------------------------------------ richieste HTTP (net.Curl)
function testoDaByte(buf) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(buf);
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return s;
}

function campiForm(campi) {
  return Object.keys(campi).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(campi[k])).join("&");
}

// Richiesta HTTP: risolve sempre con { ok, codice, corpo, errore }
function http(metodo, url, campi) {
  return new Promise(risolvi => {
    let fatto = false, corpo = "";
    const fine = r => { if (!fatto) { fatto = true; risolvi(r); } };
    setTimeout(() => fine({ ok: false, errore: "nessuna risposta" }), 6000);
    try {
      const op = net.Curl.Easy.option, easy = new net.Curl.Easy(), multi = new net.Curl.Multi();
      easy.setOpt(op.URL, url);
      if (metodo === "POST") { easy.setOpt(op.POST, true); easy.setOpt(op.POSTFIELDS, campiForm(campi)); }
      else easy.setOpt(op.HTTPGET, true);
      if (op.CONNECTTIMEOUT_MS !== undefined) easy.setOpt(op.CONNECTTIMEOUT_MS, 1500);
      if (op.TIMEOUT_MS !== undefined) easy.setOpt(op.TIMEOUT_MS, 5000);
      easy.setOpt(op.WRITEFUNCTION, buf => { corpo += testoDaByte(buf); });
      multi.onMessage((h, risultato) => {
        const codice = h.getInfo(net.Curl.info.RESPONSE_CODE);
        multi.removeHandle(h);
        multi.onMessage(null);
        if (risultato !== 0) return fine({ ok: false, errore: net.Curl.Easy.strError ? net.Curl.Easy.strError(risultato) : "errore " + risultato });
        let dati = null;
        try { dati = JSON.parse(corpo); } catch (x) { /* risposta non JSON */ }
        fine({ ok: codice >= 200 && codice < 300, codice: codice, dati: dati,
               errore: dati && dati.detail ? dati.detail : "risposta " + codice });
      });
      multi.addHandle(easy);
    } catch (err) {
      fine({ ok: false, errore: "richieste di rete non disponibili su questo pannello" });
    }
  });
}

function registratoreConfigurato() { return !!REGISTRATORE.url && typeof net !== "undefined" && !!net.Curl; }
function registratoreAttivo() { return !!reg && Date.now() - regUltimo < 3 * REGISTRATORE_OGNI_MS; }

async function aggiornaRegistratore() {
  if (regInCorso || !registratoreConfigurato()) return;
  regInCorso = true;
  const r = await http("GET", REGISTRATORE.url + "/api/pannello?token=" + encodeURIComponent(REGISTRATORE.token));
  if (r.ok && r.dati) { reg = r.dati; regUltimo = Date.now(); regErrore = ""; }
  else regErrore = r.codice === 401 ? "token errato" : r.errore;
  if (Date.now() - ultimoInvioEth > 60000) inviaElencoEth();
  regInCorso = false;
  disegna();
}

async function inviaElencoEth(subito) {
  if (!registratoreConfigurato() || !ethLetto) return;
  ultimoInvioEth = Date.now();
  await http("POST", REGISTRATORE.url + "/api/pannello/ethernet", { token: REGISTRATORE.token, righe: JSON.stringify(ethRighe) });
  if (subito) aggiornaRegistratore();
}

async function richiestaRegistratore(percorso, campi, messaggio) {
  if (!registratoreConfigurato()) { avvisa("Registratore non configurato nel JS Object.", true); return disegna(); }
  avvisa("Invio al registratore…", false);
  disegna();
  const r = await http("POST", REGISTRATORE.url + percorso, Object.assign({ token: REGISTRATORE.token }, campi));
  avvisa(r.ok ? messaggio : "Il registratore non ha eseguito l'operazione: " + r.errore, !r.ok);
  aggiornaRegistratore();
  disegna();
}

function commentoDi(chiave) { return reg && reg.commenti ? reg.commenti[chiave] || "" : ""; }

// ------------------------------------------------------------------ controllo dei dispositivi Ethernet
// Qualunque risposta, anche un rifiuto immediato della connessione, vuol dire che il dispositivo e' acceso.
function sonda(dev) {
  return new Promise(risolvi => {
    let fatto = false;
    const fine = vivo => { if (!fatto) { fatto = true; risolvi(vivo); } };
    setTimeout(() => fine(false), 3000);
    try {
      const op = net.Curl.Easy.option, easy = new net.Curl.Easy(), multi = new net.Curl.Multi();
      easy.setOpt(op.URL, "http://" + dev.ip + ":" + (dev.porta || 80) + "/");
      if (op.NOBODY !== undefined) easy.setOpt(op.NOBODY, true);
      if (op.CONNECTTIMEOUT_MS !== undefined) easy.setOpt(op.CONNECTTIMEOUT_MS, 800);
      else if (op.CONNECTTIMEOUT !== undefined) easy.setOpt(op.CONNECTTIMEOUT, 1);
      if (op.TIMEOUT_MS !== undefined) easy.setOpt(op.TIMEOUT_MS, 1500);
      multi.onMessage((h, risultato) => {
        const tempo = h.getInfo(net.Curl.info.TOTAL_TIME) || 0;
        multi.removeHandle(h);
        multi.onMessage(null);
        // 0 = risposta, 28 = timeout, 7 = connessione non riuscita (rifiutata subito = acceso)
        fine(risultato === 0 || (risultato !== 28 && !(risultato === 7 && tempo > 0.7)));
      });
      multi.addHandle(easy);
    } catch (err) {
      fine(false);
    }
  });
}

async function controllaEthernet() {
  if (sondaInCorso || !ethRighe.length || typeof net === "undefined" || !net.Curl) return;
  sondaInCorso = true;
  eth.forEach((st, i) => {                       // una riga cambiata riparte da "in verifica"
    const r = ethRighe.find(x => x.riga === i + 1), chiave = r ? r.ip + ":" + r.porta : "";
    if (st.chiave !== chiave) { st.chiave = chiave; st.online = null; st.mancate = 0; }
  });
  const righe = ethRighe.slice();
  const esiti = await Promise.all(righe.map(sonda));
  esiti.forEach((vivo, k) => {
    const st = eth[righe[k].riga - 1];
    if (vivo) { st.online = true; st.mancate = 0; }
    else { st.mancate += 1; if (st.mancate >= SONDA_TENTATIVI_OFFLINE || st.online === null && st.mancate >= 2) st.online = false; }
  });
  let maschera = 0, online = 0;
  eth.forEach((st, i) => { if (st.chiave && st.online !== null) { maschera |= 1 << i; if (st.online) online |= 1 << i; } });
  ethVita = (ethVita + 1) % 30000;
  if (self.config.ethStato) {
    try { await driver.promises.setData(self.config.ethStato, [maschera, online, ethVita]); }
    catch (err) { console.log("Sigillo: stato Ethernet non scritto nel PLC:", err); }
  }
  sondaInCorso = false;
  disegna();
}

// ------------------------------------------------------------------ registro degli eventi del PLC
// Il buffer circolare Eventi (32 x 32 byte dal byte 70) si legge solo con la scheda Registro aperta
// e solo quando SeqUltimo (byte 4, gia' letto ogni secondo con dbStato) cambia.
let eventi = null, eventiSeq = null, eventiErrore = "", seqVisto = null, pagina = 0;
async function leggiEventi(b) {
  const seq = i32(b, 4);
  if (seqVisto === null || seq < seqVisto) seqVisto = seq;          // all'avvio, o DB reinizializzato
  if (scheda !== "registro") return;
  seqVisto = seq;
  if (!self.config.dbEventi || seq === eventiSeq) return;
  try {
    const v = await leggiArea(BLOCCHI.eventi), out = [];
    for (let o = 0; o < 1024; o += 32) {
      if (i32(v, o) <= 0) continue;
      const anno = (v[o + 8] << 8) | v[o + 9];
      out.push({ seq: i32(v, o), tipo: i16(v, o + 4), indice: i16(v, o + 6), extra: i32(v, o + 20) >>> 0,
                 ora: anno ? new Date(anno, v[o + 10] - 1, v[o + 11], v[o + 13], v[o + 14], v[o + 15]) : null,
                 prima: f32(v, o + 24), dopo: f32(v, o + 28) });
    }
    eventi = out.sort((x, y) => y.seq - x.seq);
    eventiSeq = seq;
    eventiErrore = "";
  } catch (err) {
    eventiErrore = (err && err.message) || String(err);
  }
}

const TIPI_EVENTO = {
  2: "Programma e hardware approvati", 3: "Programma diverso da quello approvato", 4: "Programma tornato uguale a quello approvato",
  5: "Firma F cambiata", 6: "Avvio automatico bloccato", 7: "Avvio automatico sbloccato", 8: "Errore nella lettura del checksum",
  9: "CPU diversa da quella approvata", 10: "Quadro aperto", 11: "Quadro chiuso", 12: "Manutenzione inserita",
  13: "Manutenzione disinserita", 17: "Firmware e seriale della CPU non leggibili",
};
function testoEvento(ev) {
  const par = NOMI_PARAMETRI[ev.indice - 1] || "Parametro " + ev.indice;
  const pn = () => { const d = stato && stato.profinet.find(x => x.n === ev.indice); return d ? d.nome : "n. " + ev.indice; };
  const riga = () => { const r = ethRighe.find(x => x.riga === ev.indice); return r ? r.nome || r.ip : "riga " + ev.indice; };
  switch (ev.tipo) {
    case 1: return "Avvio del programma PLC" + (ev.dopo >= 1 ? " (avvio n. " + Math.round(ev.dopo) + ")" : "");
    case 14: return par + ": " + numero(ev.prima) + " -> " + numero(ev.dopo);
    case 15: return par + ": " + numero(ev.dopo) + " fuori limite rifiutato, resta " + numero(ev.prima);
    case 16: return "Limiti di " + par + ": " + numero(ev.prima) + " - " + numero(ev.dopo) + (ev.extra ? "" : " (disattivati)");
    case 18: case 19: return "PROFINET " + pn() + (ev.tipo === 18 ? " offline" : " di nuovo online");
    case 20: case 21: return "Ethernet " + riga() + (ev.tipo === 20 ? " offline" : " di nuovo online");
    case 26: return "Nome PROFINET n. " + ev.indice + " non leggibile";
    default: return TIPI_EVENTO[ev.tipo] || "Evento " + ev.tipo;
  }
}
function coloreEvento(t) {
  return [3, 5, 6, 9].indexOf(t) >= 0 ? COL.allarme : [7, 8, 10, 15, 16, 17, 18, 20, 26].indexOf(t) >= 0 ? COL.att : COL.inchiostro;
}

// ------------------------------------------------------------------ ingressi e uscite
// Letti solo con la scheda I/O aperta, a ogni ciclo. Solo visualizzazione: il pannello non scrive le uscite.
let io = { I: null, Q: null }, ioErrore = "", ioSelezione = "", ioPagina = 0;
function ioConfigurato() { return !!(self.config.ioIngressi || self.config.ioUscite); }
// Byte necessari in un'area: dal byte 0 fino all'ultimo canale dei moduli configurati
function byteArea(area) {
  let fine = 0;
  IO.moduli.forEach(m => {
    if (m.area === area) fine = Math.max(fine, m.byte + Math.ceil(m.bit / 8));
    if (m.area === "A" + area) fine = Math.max(fine, m.indirizzo + 2 * m.canali);
  });
  return fine;
}
function paroleArea(area) { return Math.ceil(byteArea(area) / 2); }
async function leggiIo() {
  try {
    const nI = paroleArea("I"), nQ = paroleArea("Q");
    if (self.config.ioIngressi && nI) io.I = inByte(await leggiCampo("ioIngressi", nI));
    if (self.config.ioUscite && nQ) io.Q = inByte(await leggiCampo("ioUscite", nQ));
    ioErrore = "";
  } catch (err) {
    ioErrore = (err && err.message) || String(err);
  }
}
// null = area non letta
function bitIo(area, by, bi) {
  const b = io[area];
  return !b || by >= b.length ? null : (b[by] >> bi) & 1;
}
function analogicoIo(area, ind) {
  const b = io[area];
  if (!b || ind + 1 >= b.length) return null;
  const v = (b[ind] << 8) | b[ind + 1];
  return v > 32767 ? v - 65536 : v;
}

// ------------------------------------------------------------------ disegno: strumenti
// disegna() prepara l'elenco delle operazioni; il Canvas viene ridisegnato solo se l'elenco e'
// diverso da quello gia' sullo schermo. Larghezze e testi accorciati restano in memoria.
let ops = [], opsSchermo = "", fontAtt = "13px " + FONT, base = "alphabetic", fontCanvas = "";
const misure = new Map(), tagli = new Map();
function font(px, b) { fontAtt = (b ? "bold " : "") + px + "px " + FONT; }
function misura(t) {
  if (!canvas.measureText) return t.length * 7;
  if (fontCanvas !== fontAtt) { canvas.font = fontAtt; fontCanvas = fontAtt; }
  return canvas.measureText(t).width;
}
function larghezza(t) {
  const k = fontAtt + "|" + t;
  let w = misure.get(k);
  if (w === undefined) { if (misure.size > 2000) misure.clear(); w = misura(t); misure.set(k, w); }
  return w;
}
function taglia(t, maxW) {
  if (!maxW || larghezza(t) <= maxW) return t;
  const k = fontAtt + "|" + maxW + "|" + t;
  let r = tagli.get(k);
  if (r === undefined) {
    let lo = 1, hi = t.length - 1;               // il prefisso piu' lungo che sta con "…" (almeno 1 carattere)
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (misura(t.slice(0, m) + "…") <= maxW) lo = m; else hi = m - 1; }
    r = t.slice(0, lo) + "…";
    if (tagli.size > 1000) tagli.clear();
    tagli.set(k, r);
  }
  return r;
}
function testo(t, x, y, maxW, colore, allinea) {
  ops.push(["t", taglia(String(t), maxW), x, y, colore || COL.inchiostro, allinea || "left", base, fontAtt]);
}
function rettangolo(x, y, w, h, colore) { ops.push(["r", x, y, w, h, colore]); }
function riquadro(x, y, w, h, fondo, bordo) {
  rettangolo(x, y, w, h, fondo);
  if (bordo) ops.push(["s", x + 0.5, y + 0.5, w - 1, h - 1, bordo]);
}
function mostra() {
  const firma = ops.join("\n");
  if (firma === opsSchermo) return;
  opsSchermo = firma;
  const c = canvas, st = {};
  const imposta = (k, v) => { if (st[k] !== v) { c[k] = v; st[k] = v; } };
  ops.forEach(o => {
    if (o[0] === "t") {
      imposta("fillStyle", o[4]); imposta("textAlign", o[5]); imposta("textBaseline", o[6]); imposta("font", o[7]);
      c.fillText(o[1], o[2], o[3]);
    } else if (o[0] === "r") { imposta("fillStyle", o[5]); c.fillRect(o[1], o[2], o[3], o[4]); }
    else { imposta("strokeStyle", o[5]); imposta("lineWidth", 1); c.strokeRect(o[1], o[2], o[3], o[4]); }
  });
  fontCanvas = st.font || fontCanvas;
}
function bottone(x, y, w, h, etichetta, azione, opz) {
  opz = opz || {};
  const attivo = !opz.disattivo, primario = opz.primario && attivo;
  riquadro(x, y, w, h, primario ? COL.petrolio : COL.pannello, attivo ? COL.petrolio : COL.riga);
  let fs = Math.min(16, Math.round(h * 0.36));
  font(fs, true);
  while (fs > 10 && larghezza(etichetta) > w - 10) { fs -= 1; font(fs, true); }
  base = "middle";
  testo(etichetta, x + w / 2, y + h / 2, w - 8, primario ? COL.bianco : attivo ? COL.petrolio : COL.tenue, "center");
  base = "alphabetic";
  if (attivo) bottoni.push({ x: x, y: y, w: w, h: h, azione: azione });
}
function a_capo(t, x, y, maxW, passo, colore) {
  const righe = [];
  let linea = "";
  t.split(" ").forEach(p => { const pr = linea ? linea + " " + p : p; if (larghezza(pr) > maxW && linea) { righe.push(linea); linea = p; } else linea = pr; });
  if (linea) righe.push(linea);
  righe.forEach((r, i) => testo(r, x, y + i * passo, maxW, colore));
}

// ------------------------------------------------------------------ disegno: stato
function macchinaOffline() {
  if (!stato) return [];
  return stato.profinet.filter(d => !d.online).map(d => d.nome)
    .concat(ethRighe.filter(r => eth[r.riga - 1].online === false).map(r => r.nome || r.ip));
}

function testoCollegamenti() {
  if (!stato) return "";
  const parti = [], mo = macchinaOffline();
  if (mo.length) parti.push(mo.length === 1 ? mo[0] + " offline" : mo.length + " dispositivi della macchina offline");
  if (!registratoreAttivo()) return parti.concat(["registratore non raggiungibile, rete esterna non controllata"]).join(", ");
  if (reg.esterni) parti.push(reg.esterni === 1 ? "dispositivo esterno " + reg.rete.find(d => !d.noto).ip : reg.esterni + " dispositivi esterni");
  if (reg.noti_offline) parti.push(reg.noti_offline === 1 ? reg.rete.find(d => d.noto && !d.online).nome + " offline" : reg.noti_offline + " dispositivi noti offline");
  if (reg.accesso_cpu) parti.push("accesso alla CPU segnalato");
  return parti.length ? parti.join(", ") : "tutti i dispositivi online, nessun esterno";
}

// RUN / STOP: preciso dal registratore (snap7), altrimenti dedotto dal contatore di vita.
// Il contatore e' il dato piu' fresco: se si muove la CPU e' in RUN anche se il registratore dice ancora STOP.
function statoCpu() {
  if (!stato || errore) return null;
  const r = registratoreAttivo() && reg.cpu ? reg.cpu.modo : null;
  if (vitaFerma >= 5) {
    if (r === "STOP") return { modo: "STOP", testo: "STOP", fonte: "letto dal registratore" };
    if (r === "RUN") return { modo: "FB", testo: "RUN, ma FB_SigilloBase fermo", fonte: "letto dal registratore" };
    return { modo: "FERMO", testo: "STOP o FB_SigilloBase fermo", fonte: "contatore di vita fermo" };
  }
  if (r === "RUN" || r === "STOP" && vitaMossa) return { modo: "RUN", testo: "RUN", fonte: r === "RUN" ? "letto dal registratore" : "contatore di vita in movimento" };
  if (r === "STOP") return { modo: "STOP", testo: "STOP", fonte: "letto dal registratore" };
  if (vitaMossa || vitaFerma > 0) return { modo: "RUN", testo: "RUN", fonte: "dedotto dal contatore di vita" };
  return { modo: "", testo: "in verifica", fonte: "contatore di vita" };
}

// Due fasce sempre visibili: programma e CPU sopra, dispositivi sotto, ognuna con il suo colore.
function condizioneProgramma() {
  if (errore) return ["PLC non raggiungibile", errore, COL.allarmeFondo, COL.allarme];
  if (!stato) return ["Lettura in corso…", "", COL.pannello, COL.tenue];
  const cpu = statoCpu();
  if (cpu.modo === "STOP") return ["CPU in STOP", "Letto dalla CPU dal registratore: il programma non è in esecuzione", COL.allarmeFondo, COL.allarme];
  if (cpu.modo === "FB") return ["FB_SigilloBase non in esecuzione", "La CPU è in RUN ma il contatore di vita è fermo", COL.allarmeFondo, COL.allarme];
  if (cpu.modo === "FERMO") return ["CPU in STOP o FB_SigilloBase non in esecuzione", "Il contatore di vita è fermo", COL.allarmeFondo, COL.allarme];
  if (stato.avvioBloccato) {
    const causa = !stato.riferimentoValido ? "nessun programma approvato" : !stato.hwOk ? "CPU diversa da quella approvata"
                : !stato.firmaFOk ? "firma F cambiata" : !stato.checksumOk ? "programma modificato" : "modifica rilevata";
    return ["Avvio automatico bloccato", causa.charAt(0).toUpperCase() + causa.slice(1) + ": serve l'approvazione di un utente autorizzato", COL.allarmeFondo, COL.allarme];
  }
  if (!stato.hwOk) return ["CPU diversa da quella approvata", "Firmware o numero di serie cambiati: " + (stato.cpuFw || "–") + " " + stato.cpuSeriale, COL.allarmeFondo, COL.allarme];
  if (!stato.riferimentoValido) return ["Nessun programma approvato", "Approvare il programma al termine del collaudo", COL.attFondo, COL.att];
  if (!stato.checksumOk || !stato.firmaFOk) return ["Programma diverso da quello approvato", !stato.firmaFOk ? "Firma del programma di sicurezza cambiata" : "Checksum del programma cambiato", COL.allarmeFondo, COL.allarme];
  if (stato.erroreLettura) return ["Checksum non leggibile", "Errore di GetChecksum nel PLC", COL.attFondo, COL.att];
  return ["Programma uguale a quello approvato", "Nessuna modifica rilevata", COL.okFondo, COL.ok];
}

function condizioneCollegamenti() {
  if (errore || !stato) return ["Dispositivi", "–", COL.pannello, COL.tenue];
  const att = registratoreAttivo();
  const titolo = att && reg.esterni ? "Dispositivo esterno collegato alla rete"
               : macchinaOffline().length ? "Dispositivo della macchina offline"
               : att && reg.noti_offline ? "Dispositivo noto offline"
               : att && reg.accesso_cpu ? "Accesso alla CPU segnalato" : "";
  if (titolo) return [titolo, testoCollegamenti(), COL.attFondo, COL.att];
  return ["Dispositivi online", testoCollegamenti(), COL.okFondo, COL.ok];
}

function fascia(y, h, c) {
  riquadro(12, y, W - 24, h, c[2]);
  rettangolo(12, y, 6, h, c[3]);
  font(16, true);
  const tw = Math.min(larghezza(c[0]), (W - 60) * 0.6);
  testo(c[0], 28, y + h / 2 + 6, tw + 1, c[3]);
  font(13); testo(c[1], 28 + tw + 14, y + h / 2 + 5, W - 54 - tw - 14);
}

function disegna() {
  bottoni = []; ops = []; base = "alphabetic";
  riquadro(0, 0, W, H, COL.fondo);
  const nuovi = stato && seqVisto !== null && scheda !== "registro" ? Math.min(99, stato.seq - seqVisto) : 0;
  const schede = [["stato", "Stato"], ["parametri", "Parametri"], ["dispositivi", "Dispositivi"], ["cpu", "CPU"]]
    .concat(ioConfigurato() ? [["io", "I/O"]] : [], [["registro", nuovi > 0 ? "Registro (" + nuovi + ")" : "Registro"]]);
  const hT = 36, lw = Math.min(120, Math.floor((W - 24 - 6 * (schede.length - 1)) / schede.length));
  schede.forEach((t, i) => {
    const x = 12 + i * (lw + 6), sel = scheda === t[0];
    font(14, sel);
    base = "middle";
    testo(t[1], x + lw / 2, hT / 2, lw, sel ? COL.inchiostro : COL.tenue, "center");
    base = "alphabetic";
    if (sel) rettangolo(x + 10, hT - 4, lw - 20, 3, COL.petrolio);
    bottoni.push({ x: x, y: 0, w: lw, h: hT, azione: () => { scheda = t[0]; pagina = 0; forzaLettura = true; disegna(); leggi(); } });
  });
  const yF = hT + 6;
  fascia(yF, 32, condizioneProgramma());
  fascia(yF + 36, 32, condizioneCollegamenti());
  const y0 = yF + 76, hPiede = 58, h = H - y0 - hPiede - 8;
  riquadro(12, y0, W - 24, h, COL.pannello, COL.riga);
  if (scheda === "stato") disegnaStato(y0, h);
  else if (scheda === "parametri") disegnaParametri(y0, h);
  else if (scheda === "cpu") disegnaCpu(y0, h);
  else if (scheda === "registro") disegnaRegistro(y0, h);
  else if (scheda === "io") disegnaIo(y0, h);
  else disegnaDispositivi(y0, h);
  disegnaPiede(H - hPiede);
  if (dialogo) disegnaDialogo();
  mostra();
}

// senza il tempo di ciclo, che cambia a ogni lettura: la scheda Stato resta ferma e non si ridisegna
function testoCpu() {
  const cpu = statoCpu();
  if (!cpu) return "";
  return cpu.testo;
}

function disegnaStato(y0, h) {
  const s = stato || {};
  const righe = [
    ["Progetto PLC", s.versione],
    ["Checksum approvato / attuale", s.checksumRif ? s.checksumRif + " / " + s.checksumAtt : "", s.checksumOk === false],
    ["Firma F approvata / attuale", s.firmaFRif ? s.firmaFRif + " / " + s.firmaFAtt : "", s.firmaFOk === false],
    ["CPU approvata", [s.cpuFwRif, s.cpuSerialeRif].filter(Boolean).join("  ")],
    ["CPU attuale", s.erroreIM ? "dati non leggibili" : [s.cpuFw, s.cpuSeriale].filter(Boolean).join("  "), s.hwOk === false],
    ["Quadro / manutenzione", stato ? (s.quadroAperto ? "quadro aperto" : "quadro chiuso") + ", " +
                                      (s.manutenzione ? "manutenzione inserita" : "manutenzione non inserita") : "", s.quadroAperto],
    ["Avvio automatico", stato ? (s.avvioBloccato ? "bloccato" : "consentito") : "", s.avvioBloccato],
    ["Stato della CPU", testoCpu(), !!stato && !!statoCpu() && ["STOP", "FB", "FERMO"].indexOf(statoCpu().modo) >= 0],
    ["Collegamenti", testoCollegamenti(), !!stato && (macchinaOffline().length > 0 || (registratoreAttivo() && (reg.esterni || reg.noti_offline || reg.accesso_cpu)))],
  ];
  const passo = Math.max(20, Math.min(40, Math.floor((h - 8) / righe.length)));
  righe.forEach((r, i) => {
    const y = y0 + Math.round(passo * 0.75) + i * passo;
    font(13); testo(r[0], 26, y, W * 0.28, COL.tenue);
    font(15, true); testo(r[1] || "–", 26 + W * 0.30, y, W * 0.64, r[2] ? COL.allarme : COL.inchiostro);
  });
}

function disegnaParametri(y0, h) {
  const s = stato || {};
  const passo = Math.max(14, Math.floor((h - 6) / 17)), fs = Math.max(10, Math.min(13, passo - 5));
  const cN = 24, cNome = 56, cVal = W * 0.52, cMin = W * 0.66, cMax = W * 0.80;
  let y = y0 + passo - 3;
  font(fs, true);
  testo("N.", cN, y, 30, COL.tenue); testo("Parametro", cNome, y, cVal - cNome - 10, COL.tenue);
  testo("Valore", cVal, y, cMin - cVal - 8, COL.tenue); testo("Minimo", cMin, y, cMax - cMin - 8, COL.tenue);
  testo("Massimo", cMax, y, W - cMax - 20, COL.tenue);
  font(fs);
  (s.parametri || []).forEach(p => {
    y += passo;
    if (y > y0 + h - 2) return;
    testo(p.n, cN, y, 30, COL.tenue);
    testo(NOMI_PARAMETRI[p.n - 1] || "Parametro " + p.n, cNome, y, cVal - cNome - 10);
    testo(numero(p.valore), cVal, y, cMin - cVal - 8);
    testo(p.attivo ? numero(p.min) : "–", cMin, y, cMax - cMin - 8, p.attivo ? COL.inchiostro : COL.tenue);
    testo(p.attivo ? numero(p.max) : "–", cMax, y, W - cMax - 20, p.attivo ? COL.inchiostro : COL.tenue);
  });
}

// ------------------------------------------------------------------ disegno: CPU
function due(n) { return (n < 10 ? "0" : "") + n; }
function dataOra(d) {
  return d ? due(d.getDate()) + "/" + due(d.getMonth() + 1) + "/" + d.getFullYear() + " " + due(d.getHours()) + ":" + due(d.getMinutes()) + ":" + due(d.getSeconds()) : "";
}
function durata(s) {
  s = Math.abs(Math.round(s));
  if (s < 120) return s + " s";
  if (s < 7200) return Math.floor(s / 60) + " min";
  if (s < 172800) return Math.floor(s / 3600) + " h " + Math.floor(s % 3600 / 60) + " min";
  return Math.floor(s / 86400) + " g " + Math.floor(s % 86400 / 3600) + " h";
}
function ms(v) { return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " ms"; }

function disegnaCpu(y0, h) {
  const cpu = statoCpu(), c = stato && stato.cpu;
  if (stato && !self.config.dbCpu) {
    font(14);
    a_capo("Campo dbCpu non configurato nella scheda Config (DB n byte 1822, Conteggio 17): tempi di ciclo e avvii non disponibili.",
           26, y0 + 30, W - 60, 20, COL.tenue);
  }
  const fermo = !cpu || cpu.modo === "STOP" || cpu.modo === "FB" || cpu.modo === "FERMO";
  const righe = [["Stato della CPU", cpu ? cpu.testo + " (" + cpu.fonte + ")" : "", !!cpu && fermo]];
  if (c) {
    righe.push(
      ["Tempo di ciclo attuale", fermo ? "– (FB fermo)" : ms(c.ciclo)],
      ["Tempo di ciclo min / max", ms(c.cicloMin) + " / " + ms(c.cicloMax)],
      ["Tempo dall'ultimo avvio", fermo ? "–" : durata(c.secondiDaAvvio)],
      ["Numero di avvii", String(c.avvii)]);
  }
  const yR = c || !stato ? y0 : y0 + 60, hA = self.config.cpuAzzera ? 48 : 0;
  const passo = Math.max(20, Math.min(36, Math.floor((h - (yR - y0) - hA - 8) / Math.max(righe.length, 1))));
  righe.forEach((r, i) => {
    const y = yR + Math.round(passo * 0.75) + i * passo;
    font(13); testo(r[0], 26, y, W * 0.28, COL.tenue);
    font(15, true); testo(r[1] || "–", 26 + W * 0.30, y, W * 0.64, r[2] ? COL.allarme : COL.inchiostro);
  });
  if (self.config.cpuAzzera && c) {
    const puo = !errore && stato.abilitato && !inAttesa;
    bottone(20, y0 + h - 44, 280, 36, "Azzera minimo e massimo", () => comandoPlc("azzera"), { disattivo: !puo });
  }
}

// ------------------------------------------------------------------ disegno: dispositivi
function disegnaDispositivi(y0, h) {
  const sw = 150;
  [["macchina", "Macchina"], ["rete", "Rete"]].forEach((t, i) => {
    const x = 20 + i * (sw + 8), sel = vista === t[0];
    riquadro(x, y0 + 8, sw, 30, sel ? COL.petrolio : COL.pannello, sel ? COL.petrolio : COL.riga);
    font(13, true);
    base = "middle";
    testo(t[1], x + sw / 2, y0 + 23, sw - 10, sel ? COL.bianco : COL.inchiostro, "center");
    base = "alphabetic";
    bottoni.push({ x: x, y: y0 + 8, w: sw, h: 30, azione: () => { vista = t[0]; disegna(); } });
  });
  if (vista === "macchina") disegnaMacchina(y0 + 44, h - 44);
  else disegnaRete(y0 + 44, h - 44);
}

function tabella(y0, h, intestazioni, colonne, righe, hAzioni) {
  const passo = Math.max(20, Math.min(32, Math.floor((h - hAzioni - 8) / (Math.max(righe.length, 1) + 1))));
  let y = y0 + Math.round(passo * 0.7);
  font(13, true);
  intestazioni.forEach((t, i) => testo(t, colonne[i], y, (colonne[i + 1] || W - 20) - colonne[i] - 8, COL.tenue));
  righe.forEach(r => {
    y += passo;
    if (y > y0 + h - hAzioni - 4) return;
    if (r.fondo) rettangolo(14, y - passo + 8, W - 28, passo - 2, r.fondo);
    r.celle.forEach((c, i) => {
      font(14, i === 0 || i === 3);
      testo(c[0], colonne[i], y, (colonne[i + 1] || W - 20) - colonne[i] - 8, c[1] || COL.inchiostro);
    });
    if (r.azione) bottoni.push({ x: 14, y: y - passo + 8, w: W - 28, h: passo - 2, azione: r.azione });
  });
  return y;
}

function disegnaMacchina(y0, h) {
  const s = stato || { profinet: [] };
  const puo = !!stato && !errore && s.abilitato && !inAttesa;
  const puoReg = puo && registratoreAttivo();
  const statoEth = r => eth[r.riga - 1].online === null ? ["in verifica", COL.tenue] : eth[r.riga - 1].online ? ["online", COL.ok] : ["offline", COL.att];
  const righe = s.profinet.map(d => ({
    celle: [["PROFINET n. " + d.n], [d.nome], ["–", COL.tenue], d.online ? ["online", COL.ok] : ["offline", COL.att], [commentoDi("pn:" + d.n) || "–", COL.tenue]],
    azione: puoReg ? () => { apriEditor({ modo: "commento", titolo: "Commento: " + d.nome, genere: "profinet", indice: d.n, commento: commentoDi("pn:" + d.n) }); } : null,
  })).concat(ethRighe.map(r => ({
    celle: [["Ethernet"], [r.nome || "–"], [r.ip + ":" + r.porta, COL.tenue], statoEth(r), [commentoDi("eth:" + r.ip) || "–", COL.tenue]],
    azione: puo ? () => { apriEditor({ modo: "eth", riga: r.riga, ip: r.ip, porta: String(r.porta), nome: r.nome, commento: commentoDi("eth:" + r.ip), nuovo: false }); } : null,
  })));
  const hAzioni = 44;
  tabella(y0, h, ["Tipo", "Nome", "Indirizzo", "Stato", "Commento"], [24, W * 0.20, W * 0.42, W * 0.60, W * 0.72], righe, hAzioni);
  if (!righe.length) { font(14); testo("Nessun dispositivo: collega LaddrIoSystem nel FB o aggiungi un dispositivo Ethernet.", 24, y0 + 56, W - 60, COL.tenue); }
  const yA = y0 + h - hAzioni + 4, libera = [...Array(16).keys()].map(i => i + 1).find(n => !ethRighe.some(r => r.riga === n));
  if (self.config.ethMemoria) {
    bottone(20, yA, 260, 36, "Aggiungi dispositivo Ethernet", () => {
      apriEditor({ modo: "eth", riga: libera, ip: "", porta: "80", nome: "", commento: "", nuovo: true });
    }, { disattivo: !puo || !libera || !ethLetto });
  }
  if (self.config.pnRileggi) bottone(292, yA, 200, 36, "Rileggi da TIA", () => comandoPlc("rileggi"), { disattivo: !puo });
  if (puo && righe.length) { font(12); testo("Tocca un dispositivo per modificarlo o commentarlo.", 504, yA + 23, W - 520, COL.tenue); }
}

function disegnaRete(y0, h) {
  if (!registratoreConfigurato()) { font(14); testo("Registratore non configurato in questo JS Object (REGISTRATORE.url).", 24, y0 + 30, W - 60, COL.tenue); return; }
  if (!registratoreAttivo()) { font(14); testo("Registratore non raggiungibile" + (regErrore ? ": " + regErrore : "") + ".", 24, y0 + 30, W - 60, COL.tenue); return; }
  if (!reg.rete_attiva) { font(14); testo("Controllo della rete non attivo nel registratore (\"rete\" in config.json).", 24, y0 + 30, W - 60, COL.tenue); return; }
  const puo = !!stato && !errore && stato.abilitato && !inAttesa;
  const righe = reg.rete.map(d => ({
    fondo: d.noto ? null : COL.allarmeFondo,
    celle: [[d.ip, d.noto ? (d.online ? COL.inchiostro : COL.att) : COL.allarme], [d.noto ? d.nome : "non noto", d.noto ? null : COL.allarme],
            [d.mac || "–", COL.tenue], d.locale ? ["questo PC", COL.tenue] : !d.noto ? ["da approvare", COL.allarme] : d.online ? ["online", COL.ok] : ["offline", COL.att],
            [d.commento || "–", COL.tenue]],
    azione: !puo || d.locale ? null : () => { dialogo = { tipo: "rete", ip: d.ip, nome: d.nome, noto: d.noto, commento: d.commento || "" }; disegna(); },
  }));
  tabella(y0, h, ["Indirizzo IP", "Nome", "MAC", "Stato", "Commento"], [24, W * 0.20, W * 0.40, W * 0.60, W * 0.76], righe, 0);
  if (!righe.length) { font(14); testo("Nessun dispositivo trovato finora.", 24, y0 + 56, W - 60, COL.tenue); }
}

// ------------------------------------------------------------------ disegno: registro
function disegnaRegistro(y0, h) {
  const nota = t => { font(14); a_capo(t, 26, y0 + 30, W - 60, 20, COL.tenue); };
  if (!self.config.dbEventi) return nota("Campo dbEventi non configurato nella scheda Config (DB n byte 70, Conteggio 512): gli eventi del PLC non si possono mostrare.");
  if (eventiErrore) return nota("Eventi non leggibili: " + eventiErrore);
  if (!eventi) return nota("Lettura del registro…");
  if (!eventi.length) return nota("Nessun evento nel PLC.");
  const hAzioni = 48, perPagina = Math.max(1, Math.floor((h - hAzioni - 8) / 26) - 1);
  const pagine = Math.ceil(eventi.length / perPagina);
  pagina = Math.min(pagina, pagine - 1);
  const righe = eventi.slice(pagina * perPagina, (pagina + 1) * perPagina).map(ev => ({
    celle: [[String(ev.seq), COL.tenue], [dataOra(ev.ora) || "–", COL.tenue], [testoEvento(ev), coloreEvento(ev.tipo)]],
  }));
  tabella(y0, h, ["N.", "Data e ora (CPU)", "Evento"], [24, 96, 270], righe, hAzioni);
  const yA = y0 + h - hAzioni + 6;
  bottone(20, yA, 150, 36, "Più recenti", () => { pagina -= 1; disegna(); }, { disattivo: pagina === 0 });
  bottone(180, yA, 150, 36, "Meno recenti", () => { pagina += 1; disegna(); }, { disattivo: pagina >= pagine - 1 });
  font(12);
  testo("Pagina " + (pagina + 1) + " di " + pagine + ". Il PLC conserva gli ultimi 32 eventi, lo storico completo è nel registratore.",
        342, yA + 23, W - 362, COL.tenue);
}

// ------------------------------------------------------------------ disegno: ingressi e uscite
// Un blocco per modulo di IO.moduli, a pagine: digitali come LED (16 per riga, verdi a 1), analogici
// una riga per canale con valore grezzo, valore in scala e barra. Toccando un LED se ne vede il simbolo.
function altezzaModulo(m) { return 26 + (m.area === "I" || m.area === "Q" ? Math.ceil(m.bit / 16) * 50 : m.canali * 28); }
function intervalloModulo(m) {
  if (m.area === "I" || m.area === "Q") return m.area + m.byte + ".0 - " + m.area + (m.byte + Math.floor((m.bit - 1) / 8)) + "." + ((m.bit - 1) % 8);
  const p = m.area === "AI" ? "IW" : "QW";
  return p + m.indirizzo + " - " + p + (m.indirizzo + 2 * (m.canali - 1));
}
function disegnaIo(y0, h) {
  const hInfo = 34, utile = h - hInfo - 8;
  if (!IO.moduli.length) { font(14); testo("Nessun modulo configurato: compila IO.moduli in cima al JS Object.", 24, y0 + 30, W - 60, COL.tenue); return; }
  if (ioErrore) {
    font(14); testo("Lettura degli I/O non riuscita: " + ioErrore, 24, y0 + 30, W - 60, COL.allarme);
    font(13); testo("Config: ioIngressi (IW0) con Conteggio " + paroleArea("I") + ", ioUscite (QW0) con Conteggio " + paroleArea("Q") + ".",
                    24, y0 + 54, W - 60, COL.tenue);
    return;
  }
  // pagine: si riempie lo spazio disponibile un modulo dopo l'altro
  const pagine = [[]];
  let occupato = 0;
  IO.moduli.forEach(m => {
    const hm = altezzaModulo(m) + 8;
    if (occupato + hm > utile && pagine[pagine.length - 1].length) { pagine.push([]); occupato = 0; }
    pagine[pagine.length - 1].push(m); occupato += hm;
  });
  ioPagina = Math.min(ioPagina, pagine.length - 1);
  const passo = Math.min(44, Math.floor((W - 48) / 16)), led = passo - 6;
  let y = y0 + 8;
  pagine[ioPagina].forEach(m => {
    font(14, true); testo(m.nome, 24, y + 16, W * 0.6, COL.inchiostro);
    font(12); testo(intervalloModulo(m), W * 0.62, y + 16, W * 0.34, COL.tenue);
    y += 26;
    if (m.area === "I" || m.area === "Q") {
      for (let k = 0; k < m.bit; k++) {
        const by = m.byte + Math.floor(k / 8), bi = k % 8, ind = m.area + by + "." + bi, on = bitIo(m.area, by, bi) === 1;
        const x = 24 + (k % 16) * passo, yy = y + Math.floor(k / 16) * 50, sel = ioSelezione === ind;
        if (sel) riquadro(x - 2, yy - 2, led + 4, led + 4, COL.pannello, COL.petrolio);
        riquadro(x, yy, led, led, on ? COL.ok : COL.bianco, sel ? COL.petrolio : on ? COL.ok : COL.riga);
        font(11, true); base = "middle";
        testo(by + "." + bi, x + led / 2, yy + led / 2, led - 2, on ? COL.bianco : COL.tenue, "center");
        base = "alphabetic";
        bottoni.push({ x: x, y: yy, w: led, h: led, azione: () => { ioSelezione = ind; disegna(); } });
      }
      y += Math.ceil(m.bit / 16) * 50;
    } else {
      const area = m.area === "AI" ? "I" : "Q", p = m.area === "AI" ? "IW" : "QW";
      for (let c = 0; c < m.canali; c++) {
        const ind = p + (m.indirizzo + 2 * c), v = analogicoIo(area, m.indirizzo + 2 * c);
        const sc = m.scala && v !== null ? m.scala.min + (m.scala.max - m.scala.min) * v / 27648 : null;
        font(13, true); testo(ind, 24, y + 18, 70, COL.inchiostro);
        font(13); testo(IO.simboli[ind] || "", 100, y + 18, W * 0.28, COL.tenue);
        testo(v === null ? "–" : String(v), W * 0.42, y + 18, W * 0.11, COL.inchiostro);
        if (sc !== null) testo(numero(sc) + " " + (m.scala.unita || ""), W * 0.54, y + 18, W * 0.15, COL.inchiostro);
        const xb = W * 0.70, wb = W * 0.26, f = v === null ? 0 : Math.max(0, Math.min(1, v / 27648));
        riquadro(xb, y + 6, wb, 14, COL.bianco, COL.riga);
        if (f > 0) rettangolo(xb + 1, y + 7, (wb - 2) * f, 12, COL.petrolio);
        y += 28;
      }
    }
    y += 8;
  });
  // riga informativa: segnale selezionato, pagine
  const yI = y0 + h - hInfo + 4;
  font(13);
  if (ioSelezione) {
    const parti = ioSelezione.slice(1).split("."), v = bitIo(ioSelezione[0], +parti[0], +parti[1]);
    testo(ioSelezione + (IO.simboli[ioSelezione] ? "  " + IO.simboli[ioSelezione] : "") + "  =  " + (v === null ? "–" : v),
          24, yI + 14, W * 0.6, COL.inchiostro);
  } else testo("Sola lettura. Tocca un LED per vedere nome e stato del segnale.", 24, yI + 14, W * 0.6, COL.tenue);
  if (pagine.length > 1) {
    bottone(W - 220, yI - 6, 60, 28, "<", () => { ioPagina = Math.max(0, ioPagina - 1); disegna(); }, { disattivo: ioPagina === 0 });
    font(13); testo((ioPagina + 1) + " / " + pagine.length, W - 130, yI + 13, 50, COL.tenue, "center");
    bottone(W - 92, yI - 6, 60, 28, ">", () => { ioPagina = Math.min(pagine.length - 1, ioPagina + 1); disegna(); }, { disattivo: ioPagina === pagine.length - 1 });
  }
}

function disegnaPiede(yP) {
  const s = stato || {};
  const bw = Math.min(230, (W - 36) / 2 - 60);
  const puo = !!stato && !errore && s.abilitato && !inAttesa;
  bottone(12, yP + 6, bw, 44, "Approva programma", () => { dialogo = { tipo: "approva" }; disegna(); }, { primario: true, disattivo: !puo });
  bottone(24 + bw, yP + 6, bw, 44, "Sblocca avvio", () => { dialogo = { tipo: "sblocca" }; disegna(); }, { disattivo: !puo || !s.avvioBloccato });
  const xM = 36 + 2 * bw;
  font(13);
  if (avviso && Date.now() < avviso.fino) a_capo(avviso.testo, xM, yP + 24, W - xM - 12, 17, avviso.errore ? COL.allarme : COL.ok);
  else if (stato && !s.abilitato) a_capo("Comandi riservati all'amministratore: accedere con il proprio utente.", xM, yP + 24, W - xM - 12, 17, COL.tenue);
}

// ------------------------------------------------------------------ dialoghi
function disegnaDialogo() {
  riquadro(0, 0, W, H, COL.velo);
  bottoni = [];
  if (dialogo.tipo === "edit") return disegnaEditor();
  const d = dialogo, w = Math.min(500, W - 40), h = 190, x = (W - w) / 2, y = (H - h) / 2;
  let t, pulsanti;
  const chiudi = () => { dialogo = null; disegna(); };
  if (d.tipo === "rete" && !d.noto) {
    t = ["Approvare il dispositivo " + d.ip + "?", "Diventa un dispositivo noto della macchina: da ora se ne registrano online e offline. Nome e commento si possono aggiungere dopo."];
    pulsanti = [["Annulla", chiudi], ["Approva", () => { dialogo = null; richiestaRegistratore("/api/pannello/approva", { ip: d.ip }, "Dispositivo " + d.ip + " approvato."); }, true]];
  } else if (d.tipo === "rete") {
    t = [d.nome + " (" + d.ip + ")", d.commento ? "Commento: " + d.commento : "Nessun commento."];
    pulsanti = [["Annulla", chiudi],
                ["Commenta", () => apriEditor({ modo: "commento", titolo: "Commento: " + d.nome, genere: "rete", ip: d.ip, commento: d.commento })],
                ["Revoca", () => { dialogo = null; richiestaRegistratore("/api/pannello/revoca", { ip: d.ip }, "Approvazione di " + d.ip + " revocata."); }]];
  } else {
    t = d.tipo === "approva" ? ["Approvare il programma attuale?", "Programma, firma F e CPU attuali diventano il riferimento. L'operazione resta nel registro."]
                             : ["Sbloccare l'avvio automatico?", "La macchina potrà ripartire con un programma non approvato. L'operazione resta nel registro."];
    pulsanti = [["Annulla", chiudi], ["Conferma", () => { const tipo = d.tipo; dialogo = null; comandoPlc(tipo); }, true]];
  }
  riquadro(x, y, w, h, COL.pannello, COL.riga);
  font(18, true); testo(t[0], x + 18, y + 34, w - 36);
  font(13); a_capo(t[1], x + 18, y + 60, w - 36, 18, COL.inchiostro);
  const n = pulsanti.length, bw = (w - 36 - (n - 1) * 12) / n;
  pulsanti.forEach((p, i) => bottone(x + 18 + i * (bw + 12), y + h - 58, bw, 44, p[0], p[1], { primario: !!p[2] }));
}

// ------------------------------------------------------------------ editor con tastiera
const TASTI_NUMERI = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [".", "0", "Canc"]];
const TASTI_NOME = [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
                    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "-"], ["Maiusc", "z", "x", "c", "v", "b", "n", "m", "_", "Canc"], ["Spazio"]];
const TASTI_TESTO = [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
                     ["a", "s", "d", "f", "g", "h", "j", "k", "l", "-"], ["Maiusc", "z", "x", "c", "v", "b", "n", "m", ".", "Canc"], [",", "Spazio", "/"]];
const LIMITI = { ip: 15, porta: 5, nome: 16, commento: 40 };

function apriEditor(e) {
  const campi = e.modo === "commento" ? ["commento"] : ["ip", "porta", "nome"].concat(registratoreAttivo() ? ["commento"] : []);
  dialogo = Object.assign({ campi: campi, campo: campi[0], maiusc: false, errore: "", conferma: false,
                            ip: "", porta: "", nome: "", commento: "" }, e, { tipo: "edit" });   // tipo = sempre editor
  disegna();
}

function ipValido(ip) {
  const p = ip.split(".");
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x <= 255) && ip !== "0.0.0.0";
}

function tasto(k) {
  const d = dialogo;
  d.errore = ""; d.conferma = false;
  if (k === "Canc") d[d.campo] = d[d.campo].slice(0, -1);
  else if (k === "Maiusc") d.maiusc = !d.maiusc;
  else if (d[d.campo].length < LIMITI[d.campo]) {
    if (d.campo === "porta" && k === ".") return disegna();
    d[d.campo] += k === "Spazio" ? " " : d.maiusc ? k.toUpperCase() : k;
  }
  disegna();
}

function salvaEditor() {
  const d = dialogo;
  if (d.modo === "commento") {
    dialogo = null;
    return richiestaRegistratore("/api/pannello/commento", { tipo: d.genere, indice: d.indice || 0, ip: d.ip || "", testo: d.commento.trim() }, "Commento salvato.");
  }
  const porta = +d.porta;
  if (!ipValido(d.ip)) d.errore = "Indirizzo IP non valido (es. 192.168.0.11).";
  else if (!(porta >= 1 && porta <= 65535)) d.errore = "Porta non valida (1-65535): 80 per una pagina web, 102 per un PLC Siemens.";
  else if (ethRighe.some(r => r.ip === d.ip && r.riga !== d.riga)) d.errore = "Questo indirizzo è già nell'elenco.";
  if (d.errore) return disegna();
  dialogo = null;
  const nuove = ethRighe.filter(r => r.riga !== d.riga).concat([{ riga: d.riga, ip: d.ip, porta: porta, nome: d.nome.trim() }])
                        .sort((a, b) => a.riga - b.riga);
  salvaMemoriaEth(nuove, "Dispositivo " + (d.nome.trim() || d.ip) + " salvato.");
  if (d.campi.indexOf("commento") >= 0 && d.commento.trim() !== commentoDi("eth:" + d.ip)) {
    richiestaRegistratore("/api/pannello/commento", { tipo: "ethernet", ip: d.ip, testo: d.commento.trim() }, "Dispositivo e commento salvati.");
  }
}

function disegnaEditor() {
  const d = dialogo;
  const w = Math.min(760, W - 16), h = Math.min(470, H - 16), x = (W - w) / 2, y = (H - h) / 2;
  riquadro(x, y, w, h, COL.pannello, COL.riga);
  font(18, true);
  testo(d.modo === "commento" ? d.titolo : (d.nuovo ? "Nuovo dispositivo Ethernet" : "Dispositivo Ethernet") + ", riga " + d.riga, x + 16, y + 30, w - 32);
  // campi: IP, porta e nome sulla prima riga, commento a tutta larghezza
  const etichette = { ip: "Indirizzo IP", porta: "Porta", nome: "Nome", commento: "Commento (salvato nel registratore)" };
  const quote = { ip: 0.38, porta: 0.16, nome: 0.38 };
  const prima = d.campi.filter(c => c !== "commento"), utile = w - 32 - 2 * 12;
  let cx = x + 16, yRiga = y + 40;
  const campo = (c, cx, cy, cw) => {
    const sel = d.campo === c;
    font(12); testo(etichette[c], cx, cy + 12, cw, COL.tenue);
    riquadro(cx, cy + 18, cw, 36, COL.bianco, sel ? COL.petrolio : COL.riga);
    if (sel) rettangolo(cx, cy + 52, cw, 2, COL.petrolio);
    font(16, true); testo(d[c] + (sel ? "|" : ""), cx + 8, cy + 42, cw - 16, COL.inchiostro);
    bottoni.push({ x: cx, y: cy, w: cw, h: 54, azione: () => { d.campo = c; disegna(); } });
  };
  prima.forEach(c => { const cw = utile * quote[c] / 0.92; campo(c, cx, yRiga, cw); cx += cw + 12; });
  if (prima.length) yRiga += 58;
  if (d.campi.indexOf("commento") >= 0) { campo("commento", x + 16, yRiga, w - 32); yRiga += 58; }
  // tastiera
  const tasti = d.campo === "ip" || d.campo === "porta" ? TASTI_NUMERI : d.campo === "nome" ? TASTI_NOME : TASTI_TESTO;
  const yK = yRiga + 6, hK = y + h - 66 - yK, nRighe = tasti.length;
  const hTasto = Math.max(24, Math.min(46, Math.floor((hK - (nRighe - 1) * 6) / nRighe)));
  const colMax = Math.max(...tasti.map(r => r.length));
  const wTasto = Math.min(tasti === TASTI_NUMERI ? 90 : 64, Math.floor((w - 32 - (colMax - 1) * 6) / colMax));
  tasti.forEach((riga, i) => {
    const largh = k => k === "Spazio" ? wTasto * 5 : wTasto;
    const tot = riga.reduce((a, k) => a + largh(k), 0) + (riga.length - 1) * 6;
    let kx = x + (w - tot) / 2;
    riga.forEach(k => {
      bottone(kx, yK + i * (hTasto + 6), largh(k), hTasto, k.length === 1 && d.maiusc ? k.toUpperCase() : k, () => tasto(k),
              { primario: k === "Maiusc" && d.maiusc });
      kx += largh(k) + 6;
    });
  });
  if (d.errore) { font(13); testo(d.errore, x + 16, y + h - 64, w - 32, COL.allarme); }
  const bw = Math.min(180, (w - 64) / 3), yB = y + h - 56;
  bottone(x + 16, yB, bw, 44, "Annulla", () => { dialogo = null; disegna(); });
  if (d.modo === "eth" && !d.nuovo) {
    bottone(x + (w - bw) / 2, yB, bw, 44, d.conferma ? "Conferma cancella" : "Cancella riga", () => {
      if (!d.conferma) { d.conferma = true; disegna(); return; }
      dialogo = null;
      salvaMemoriaEth(ethRighe.filter(r => r.riga !== d.riga), "Riga " + d.riga + " cancellata.");
    });
  }
  bottone(x + w - 16 - bw, yB, bw, 44, "Salva", salvaEditor, { primario: true });
}

// ------------------------------------------------------------------ interazione e avvio
area.on("click", ev => {
  for (let i = bottoni.length - 1; i >= 0; i--) {
    const b = bottoni[i];
    if (ev.x >= b.x && ev.x <= b.x + b.w && ev.y >= b.y && ev.y <= b.y + b.h) { b.azione(); return; }
  }
});

disegna();
leggi();
leggiMemoriaEth().then(controllaEthernet);
aggiornaRegistratore();
setInterval(leggi, 1000);
setInterval(() => { if (!ethLetto) leggiMemoriaEth(); controllaEthernet(); }, SONDA_OGNI_MS);
setInterval(aggiornaRegistratore, REGISTRATORE_OGNI_MS);
