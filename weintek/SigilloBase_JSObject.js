/*
 * Sigillo Base v2.0 – JS Object per pannelli Weintek cMT-X (EasyBuilder Pro 6.05.02 o successivo)
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
 *   ethMemoria      Local HMI, RW (es. RW-1000), 16-bit Unsigned, Conteggio 192 (elenco Ethernet, ritentivo)
 *   cmdApprova      tag DB_SigilloBase.Cmd.ImpostaRiferimento   Bit
 *   cmdSblocca      tag DB_SigilloBase.Cmd.SbloccaAvvio         Bit
 *   pnRileggi       tag DB_SigilloBase.PnCmd.Rileggi            Bit (facoltativo)
 *   abilitaComandi  bit interno, es. LB-9000 (facoltativo): a 1 solo con amministratore loggato
 * Se il driver non legge un blocco lungo, dividilo in pezzi da 62 parole: campo2, campo3...
 * (es. dbPn2 dal byte 1488, dbPn3 dal 1612, dbPn4 dal 1736).
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
const FONT = "Arial";
const SONDA_OGNI_MS = 5000, SONDA_TENTATIVI_OFFLINE = 3, REGISTRATORE_OGNI_MS = 5000;

// ------------------------------------------------------------------ costanti
// [campo, parole, byte di partenza]; i campi con numero sono facoltativi (lettura divisa)
function blocchi(campo, inizio, parole) {
  const out = [[campo, parole, inizio]];
  for (let k = 1; k * 62 < parole; k++) out.push([campo + (k + 1), Math.min(62, parole - k * 62), inizio + k * 124]);
  return out;
}
const BLOCCHI = { stato: blocchi("dbStato", 0, 35), est: blocchi("dbEst", 1094, 135), pn: blocchi("dbPn", 1364, 229) };
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

let stato = null, errore = null, vitaPrec = null, vitaFerma = 0;
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
    vita: i32(b, 0),
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

async function leggi() {
  if (lettura) return;
  lettura = true;
  try {
    const b = await leggiArea(BLOCCHI.stato);
    const e = await leggiArea(BLOCCHI.est);
    const p = self.config.dbPn ? await leggiArea(BLOCCHI.pn) : new Uint8Array(458);
    let abilitato = true;
    if (self.config.abilitaComandi) abilitato = !!(await leggiCampo("abilitaComandi", 1))[0];
    stato = decodifica(b, e, p, abilitato);
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
    const campo = tipo === "approva" ? "cmdApprova" : tipo === "sblocca" ? "cmdSblocca" : "pnRileggi";
    if (!self.config[campo]) throw new Error("campo " + campo + " non configurato");
    await driver.promises.setData(self.config[campo], [1]);
    if (tipo === "rileggi") avvisa("Lettura dei nomi PROFINET avviata.", false);
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

// ------------------------------------------------------------------ disegno: strumenti
function font(px, b) { canvas.font = (b ? "bold " : "") + px + "px " + FONT; }
function larghezza(t) { return canvas.measureText ? canvas.measureText(t).width : t.length * 7; }
function testo(t, x, y, maxW, colore, allinea) {
  t = String(t);
  canvas.fillStyle = colore || COL.inchiostro;
  canvas.textAlign = allinea || "left";
  if (maxW && larghezza(t) > maxW) { while (t.length > 1 && larghezza(t + "…") > maxW) t = t.slice(0, -1); t += "…"; }
  canvas.fillText(t, x, y);
}
function riquadro(x, y, w, h, fondo, bordo) {
  canvas.fillStyle = fondo;
  canvas.fillRect(x, y, w, h);
  if (bordo) { canvas.strokeStyle = bordo; canvas.lineWidth = 1; canvas.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
}
function bottone(x, y, w, h, etichetta, azione, opz) {
  opz = opz || {};
  const attivo = !opz.disattivo, primario = opz.primario && attivo;
  riquadro(x, y, w, h, primario ? COL.petrolio : COL.pannello, attivo ? COL.petrolio : COL.riga);
  let fs = Math.min(16, Math.round(h * 0.36));
  font(fs, true);
  while (fs > 10 && larghezza(etichetta) > w - 10) { fs -= 1; font(fs, true); }
  canvas.textBaseline = "middle";
  testo(etichetta, x + w / 2, y + h / 2, w - 8, primario ? COL.bianco : attivo ? COL.petrolio : COL.tenue, "center");
  canvas.textBaseline = "alphabetic";
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
  if (!registratoreAttivo()) return parti.concat(["rete esterna non controllata (registratore non raggiungibile)"]).join(", ");
  if (reg.esterni) parti.push(reg.esterni === 1 ? "dispositivo esterno " + reg.rete.find(d => !d.noto).ip : reg.esterni + " dispositivi esterni");
  if (reg.noti_offline) parti.push(reg.noti_offline === 1 ? reg.rete.find(d => d.noto && !d.online).nome + " offline" : reg.noti_offline + " dispositivi noti offline");
  if (reg.accesso_cpu) parti.push("accesso alla CPU segnalato");
  return parti.length ? parti.join(", ") : "tutti i dispositivi online, nessun esterno";
}

function condizione() {
  if (errore) return ["PLC non raggiungibile", errore, COL.allarmeFondo, COL.allarme];
  if (!stato) return ["Lettura in corso…", "", COL.pannello, COL.tenue];
  if (vitaFerma >= 5) return ["FB_SigilloBase non in esecuzione", "Il contatore di vita è fermo", COL.allarmeFondo, COL.allarme];
  if (stato.avvioBloccato) {
    const causa = !stato.riferimentoValido ? "Nessun programma approvato" : !stato.hwOk ? "CPU diversa da quella approvata"
                : !stato.firmaFOk ? "Firma F cambiata" : !stato.checksumOk ? "Programma modificato" : "Modifica rilevata";
    return ["Avvio automatico bloccato", causa + ": serve l'approvazione di un utente autorizzato", COL.allarmeFondo, COL.allarme];
  }
  if (!stato.hwOk) return ["CPU diversa da quella approvata", "Firmware o numero di serie cambiati: " + (stato.cpuFw || "–") + " " + stato.cpuSeriale, COL.allarmeFondo, COL.allarme];
  if (!stato.riferimentoValido) return ["Nessun programma approvato", "Approvare il programma al termine del collaudo", COL.attFondo, COL.att];
  if (!stato.checksumOk || !stato.firmaFOk) return ["Programma diverso da quello approvato", !stato.firmaFOk ? "Firma del programma di sicurezza cambiata" : "Checksum del programma cambiato", COL.allarmeFondo, COL.allarme];
  if (stato.erroreLettura) return ["Checksum non leggibile", "Errore di GetChecksum nel PLC", COL.attFondo, COL.att];
  if (registratoreAttivo() && reg.esterni) return ["Dispositivo esterno collegato alla rete", testoCollegamenti(), COL.attFondo, COL.att];
  if (macchinaOffline().length) return ["Dispositivo della macchina offline", testoCollegamenti(), COL.attFondo, COL.att];
  if (registratoreAttivo() && (reg.noti_offline || reg.accesso_cpu)) {
    return [reg.noti_offline ? "Dispositivo noto offline" : "Accesso alla CPU segnalato", testoCollegamenti(), COL.attFondo, COL.att];
  }
  return ["Programma uguale a quello approvato", "Nessuna modifica rilevata", COL.okFondo, COL.ok];
}

function disegna() {
  bottoni = [];
  riquadro(0, 0, W, H, COL.fondo);
  const hT = 36, lw = 120;
  [["stato", "Stato"], ["parametri", "Parametri"], ["dispositivi", "Dispositivi"]].forEach((t, i) => {
    const x = 12 + i * (lw + 6), sel = scheda === t[0];
    font(14, sel);
    canvas.textBaseline = "middle";
    testo(t[1], x + lw / 2, hT / 2, lw, sel ? COL.inchiostro : COL.tenue, "center");
    canvas.textBaseline = "alphabetic";
    if (sel) { canvas.fillStyle = COL.petrolio; canvas.fillRect(x + 10, hT - 4, lw - 20, 3); }
    bottoni.push({ x: x, y: 0, w: lw, h: hT, azione: () => { scheda = t[0]; disegna(); } });
  });
  const c = condizione(), yF = hT + 6;
  riquadro(12, yF, W - 24, 56, c[2]);
  canvas.fillStyle = c[3];
  canvas.fillRect(12, yF, 6, 56);
  font(19, true); testo(c[0], 30, yF + 25, W - 60, c[3]);
  font(13); testo(c[1], 30, yF + 45, W - 60);
  const y0 = yF + 66, hPiede = 58, h = H - y0 - hPiede - 8;
  riquadro(12, y0, W - 24, h, COL.pannello, COL.riga);
  if (scheda === "stato") disegnaStato(y0, h);
  else if (scheda === "parametri") disegnaParametri(y0, h);
  else disegnaDispositivi(y0, h);
  disegnaPiede(H - hPiede);
  if (dialogo) disegnaDialogo();
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
    ["Collegamenti", testoCollegamenti(), !!stato && (macchinaOffline().length > 0 || (registratoreAttivo() && (reg.esterni || reg.noti_offline || reg.accesso_cpu)))],
  ];
  const passo = Math.max(20, Math.min(40, Math.floor((h - 8) / righe.length)));
  righe.forEach((r, i) => {
    const y = y0 + Math.round(passo * 0.75) + i * passo;
    font(13); testo(r[0], 26, y, W * 0.36, COL.tenue);
    font(15, true); testo(r[1] || "–", 26 + W * 0.38, y, W * 0.56, r[2] ? COL.allarme : COL.inchiostro);
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

// ------------------------------------------------------------------ disegno: dispositivi
function disegnaDispositivi(y0, h) {
  const sw = 150;
  [["macchina", "Macchina"], ["rete", "Rete"]].forEach((t, i) => {
    const x = 20 + i * (sw + 8), sel = vista === t[0];
    riquadro(x, y0 + 8, sw, 30, sel ? COL.petrolio : COL.pannello, sel ? COL.petrolio : COL.riga);
    font(13, true);
    canvas.textBaseline = "middle";
    testo(t[1], x + sw / 2, y0 + 23, sw - 10, sel ? COL.bianco : COL.inchiostro, "center");
    canvas.textBaseline = "alphabetic";
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
    if (r.fondo) { canvas.fillStyle = r.fondo; canvas.fillRect(14, y - passo + 8, W - 28, passo - 2); }
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
    if (sel) { canvas.fillStyle = COL.petrolio; canvas.fillRect(cx, cy + 52, cw, 2); }
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
