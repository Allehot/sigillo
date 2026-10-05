// Banco di prova del JS Object Sigillo Base v2.1: simula Canvas, MouseArea, driver Weintek,
// la memoria RW del pannello, i dispositivi Ethernet e il registratore che risponde via HTTP.
// Uso: node banco_jsobject.js <SigilloBase_JSObject.js> <db.bin>  -> JSON con l'esito degli scenari
"use strict";
const fs = require("fs");
const [, , fileJs, fileDb] = process.argv;
const codice = fs.readFileSync(fileJs, "utf8");
const W = 800, H = 480, pausa = ms => new Promise(r => setTimeout(r, ms));
const URL_REG = "http://192.168.0.50:8150", TOKEN = "cambia-questa-chiave";

// memoria RW del pannello con le righe Ethernet (stesso formato del JS Object)
function memoriaEth(righe) {
  const m = Buffer.alloc(384);
  righe.forEach(r => {
    const o = (r.riga - 1) * 24;
    r.ip.split(".").forEach((x, i) => { m[o + i] = +x; });
    m.writeUInt16BE(r.porta, o + 4);
    m[o + 6] = 16; m[o + 7] = r.nome.length; m.write(r.nome, o + 8, "latin1");
  });
  const v = []; for (let i = 0; i < 384; i += 2) v.push(m.readUInt16BE(i));
  return v;
}

function crea(opz) {
  const db = Buffer.from(fs.readFileSync(fileDb));
  const ora = new Date();                       // ora della CPU aggiornata dal FB (DTL al byte 1834)
  db.writeUInt16BE(ora.getFullYear(), 1834);
  [ora.getMonth() + 1, ora.getDate(), ora.getDay() + 1, ora.getHours(), ora.getMinutes(), ora.getSeconds()].forEach((x, i) => { db[1836 + i] = x; });
  if (opz.prepara) opz.prepara(db);
  let rw = opz.memoria ? memoriaEth(opz.memoria) : new Array(192).fill(0);
  const scritture = [], richieste = [];
  let testi = [], click = null;
  const timer = [];
  class Canvas {
    constructor() { this.width = W; this.height = H; this.font = "13px Arial"; this.textAlign = "left"; }
    fillRect(x, y, w, h) { if (!x && !y && w === W && h === H && !/rgba/.test(this.fillStyle)) testi = []; }
    strokeRect() {}
    measureText(t) { return { width: t.length * parseInt(/(\d+)px/.exec(this.font)[1], 10) * 0.55 }; }
    fillText(t, x, y) { const w = this.measureText(t).width; const x0 = this.textAlign === "center" ? x - w / 2 : x; testi.push({ t: String(t), x: x0 + w / 2, y }); }
  }
  class MouseArea { on(e, f) { if (e === "click") click = f; } }
  const config = { dbStato: { byte: 0 }, dbEst: { byte: 1094 }, dbPn: { byte: 1364 }, ethStato: { word: 1396 },
                   ethMemoria: { rw: true }, cmdApprova: { bit: 0 }, cmdSblocca: { bit: 1 }, pnRileggi: { bitAddr: 1402 },
                   dbCpu: { byte: 1822 }, cpuAzzera: { bitAddr: 1854 } };
  if (opz.senzaCpu) { delete config.dbCpu; delete config.cpuAzzera; }
  if (opz.diviso) Object.assign(config, { dbPn2: { byte: 1488 }, dbPn3: { byte: 1612 }, dbPn4: { byte: 1736 }, dbEst2: { byte: 1218 }, dbEst3: { byte: 1342 } });
  if (opz.abilita !== undefined) config.abilitaComandi = { lb: true };
  const driver = { promises: {
    async getData(a, n) {
      if (opz.guasto) throw new Error("cannot get data");
      if (opz.diviso && n > 62) throw new Error("cannot get data");
      if (a.lb) return { values: [opz.abilita ? 1 : 0] };
      if (a.rw) return { values: rw.slice(0, n) };
      if (!opz.vitaFerma && a.byte === 0) db.writeInt32BE(db.readInt32BE(0) + 1, 0);
      const v = []; for (let i = 0; i < n; i++) v.push(db.readUInt16BE(a.byte + 2 * i)); return { values: v };
    },
    async setData(a, val) {
      scritture.push(a);
      if (a.rw) rw = val.slice();
      else if (a.word !== undefined) val.forEach((x, i) => db.writeUInt16BE(x, a.word + 2 * i));
      else if (a.bitAddr !== undefined) db[a.bitAddr] |= 1;
      else db[10] |= (1 << a.bit);
    } } };
  // registratore e dispositivi Ethernet simulati
  const statoReg = Object.assign({ ok: true, rete_attiva: true, rete: [], esterni: 0, noti_offline: 0, accesso_cpu: false, commenti: {} }, opz.registratore || {});
  class Easy {
    constructor() { this.o = {}; }
    setOpt(k, v) { this.o[k] = v; }
    getInfo(k) { return k === "CODICE" ? this.codice : this.tempo; }
  }
  Easy.option = { URL: "URL", POST: "POST", POSTFIELDS: "POSTFIELDS", HTTPGET: "HTTPGET", WRITEFUNCTION: "WF",
                  NOBODY: "NOBODY", CONNECTTIMEOUT_MS: "CT", TIMEOUT_MS: "TO" };
  Easy.strError = c => "errore curl " + c;
  class Multi {
    onMessage(cb) { this.cb = cb; }
    removeHandle() {}
    addHandle(e) {
      const url = e.o.URL;
      setTimeout(() => {
        if (url.startsWith(URL_REG)) {
          if (opz.registratoreSpento) return this.cb && this.cb(e, 7);
          const campi = {};
          (e.o.POSTFIELDS || "").split("&").filter(Boolean).forEach(p => { const [k, v] = p.split("="); campi[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
          const percorso = url.slice(URL_REG.length).split("?")[0];
          const token = e.o.POST ? campi.token : decodeURIComponent((/token=([^&]*)/.exec(url) || [])[1] || "");
          richieste.push({ percorso, campi, token });
          let corpo, codice = 200;
          if (token !== (opz.tokenRegistratore || TOKEN)) { codice = 401; corpo = { detail: "token errato" }; }
          else if (percorso === "/api/pannello") corpo = statoReg;
          else corpo = { ok: true };
          e.codice = codice;
          e.o.WF(Buffer.from(JSON.stringify(corpo)));
          return this.cb && this.cb(e, 0);
        }
        const ip = /http:\/\/([\d.]+):/.exec(url)[1], [cod, tempo] = (opz.esitiRete || {})[ip] || [28, 0.8];
        e.tempo = tempo;
        this.cb && this.cb(e, cod);
      }, 1);
    }
  }
  const net = { Curl: { Easy, Multi, info: { TOTAL_TIME: "T", RESPONSE_CODE: "CODICE" } } };
  new Function("driver", "Canvas", "MouseArea", "setInterval", "net", codice)
    .call({ widget: { add() {} }, config }, driver, Canvas, MouseArea, f => { timer.push(f); }, net);
  return {
    db, scritture, richieste, statoReg, rw: () => rw, testi: () => testi.map(x => x.t).join(" | "),
    async ciclo(n = 1) { for (let i = 0; i < n; i++) { timer[0](); await pausa(5); } },
    async sonda(n = 1) { for (let i = 0; i < n; i++) { timer[1](); await pausa(15); } },
    async registratore() { timer[2](); await pausa(15); },
    async scrivi(t) { for (const ch of t) await this.clicca(ch === " " ? "Spazio" : ch); },
    async clicca(et) {
      const b = testi.filter(x => x.t === et).pop();
      if (!b) throw new Error("manca " + et + " in " + testi.map(x => x.t).join(" | "));
      click({ x: b.x, y: b.y }); await pausa(10);
    },
  };
}

(async () => {
  const e = {}, v = (k, c) => { e[k] = !!c; };
  let t;
  const reteEsterno = { rete: [{ ip: "192.168.0.1", nome: "PLC", mac: "00:1B:1B:12:34:56", online: true, noto: true, commento: "", locale: false },
                               { ip: "192.168.0.50", nome: "", mac: "A4:5E:60:AA:BB:CC", online: true, noto: false, commento: "", locale: false },
                               { ip: "192.168.0.60", nome: "Questo PC", mac: "", online: true, noto: true, commento: "registratore Sigillo", locale: true }],
                        esterni: 1 };

  // 1. stato, approvazione e sblocco (comandi al PLC)
  let o = crea({ prepara: db => { db[1380] |= 0b110; } }); await pausa(20); await o.ciclo();   // tutti i PROFINET online
  v("stato_ok", o.testi().includes("Programma uguale a quello approvato") && o.testi().includes("COMMESSA-DEMO-V1.0"));
  await o.clicca("Approva programma"); await o.clicca("Conferma");
  v("scrive_approva", o.scritture.some(a => a.bit === 0));
  o.db[10] &= ~1; await o.ciclo();
  v("conferma_approva", o.testi().includes("Programma approvato."));
  o = crea({ prepara: db => { db[12] = (db[12] & ~2) | 8; } }); await pausa(20); await o.ciclo();
  v("bloccato", o.testi().includes("Avvio automatico bloccato"));
  await o.clicca("Sblocca avvio"); await o.clicca("Conferma");
  v("scrive_sblocca", o.scritture.some(a => a.bit === 1));

  // 2. PROFINET con i nomi letti dal PLC
  o = crea({}); await pausa(20); await o.ciclo();
  await o.clicca("Dispositivi");
  t = o.testi();
  v("nomi_profinet", t.includes("PROFINET n. 1") && t.includes("sew-movimot-1") && t.includes("tbn-ll-8iol") && t.includes("offline"));
  await o.clicca("Rileggi da TIA");
  v("rileggi_tia", (o.db[1402] & 1) === 1);

  // 3. elenco Ethernet nella memoria del pannello, controllo e stato scritto nel PLC
  o = crea({ memoria: [{ riga: 1, ip: "192.168.0.11", porta: 80, nome: "Telecamera" }],
             esitiRete: { "192.168.0.11": [0, 0.02] } });
  await pausa(40); await o.ciclo(); await o.sonda();
  await o.clicca("Dispositivi");
  t = o.testi();
  v("ethernet_da_memoria", t.includes("Telecamera") && t.includes("192.168.0.11:80") && t.includes("online"));
  v("stato_eth_nel_plc", o.db.readUInt16BE(1396) === 1 && o.db.readUInt16BE(1398) === 1 && o.db.readUInt16BE(1400) > 0);
  v("elenco_inviato_al_registratore", o.richieste.some(r => r.percorso === "/api/pannello/ethernet" && r.campi.righe.includes("Telecamera")));

  // 4. aggiunta di un dispositivo con il commento (registratore attivo)
  o = crea({ memoria: [{ riga: 1, ip: "192.168.0.11", porta: 80, nome: "Telecamera" }], esitiRete: { "192.168.0.11": [0, 0.02] } });
  await pausa(40); await o.ciclo(); await o.registratore();
  await o.clicca("Dispositivi");
  await o.clicca("Aggiungi dispositivo Ethernet");
  v("editor_con_commento", o.testi().includes("Nuovo dispositivo Ethernet, riga 2") && o.testi().includes("Commento (salvato nel registratore)"));
  await o.scrivi("300.1.1.1"); await o.clicca("Salva");
  v("ip_non_valido", o.testi().includes("Indirizzo IP non valido (es. 192.168.0.11)."));
  for (let i = 0; i < 9; i++) await o.clicca("Canc");
  await o.scrivi("192.168.0.30");
  await o.clicca("Porta"); await o.clicca("Canc"); await o.clicca("Canc"); await o.scrivi("102");
  await o.clicca("Nome"); await o.clicca("Maiusc"); await o.clicca("R"); await o.clicca("Maiusc"); await o.scrivi("obot1");
  await o.clicca("Commento (salvato nel registratore)"); await o.scrivi("cella 2");
  await o.clicca("Salva"); await pausa(30);
  const m = o.rw();
  v("salvato_in_memoria", m[12] === ((192 << 8) | 168) && m[13] === 30 && m[14] === 102);
  v("commento_al_registratore", o.richieste.some(r => r.percorso === "/api/pannello/commento" && r.campi.tipo === "ethernet"
                                                  && r.campi.ip === "192.168.0.30" && r.campi.testo === "cella 2"));
  v("nuovo_elenco_al_registratore", o.richieste.some(r => r.percorso === "/api/pannello/ethernet" && r.campi.righe.includes("Robot1")));
  await o.ciclo();
  await o.clicca("Telecamera"); await o.clicca("Cancella riga"); await o.clicca("Conferma cancella"); await pausa(20);
  v("cancellato_dalla_memoria", o.rw()[0] === 0 && o.rw()[1] === 0);

  // 5. rete dal registratore: esterno, approvazione, commento di un noto, commento PROFINET
  o = crea({ registratore: Object.assign({}, reteEsterno, { commenti: { "pn:1": "azionamento nastro 1" } }) });
  await pausa(30); await o.ciclo(); await o.registratore(); await o.ciclo();
  v("fascia_esterno", o.testi().includes("Dispositivo esterno collegato alla rete") && o.testi().includes("dispositivo esterno 192.168.0.50"));
  await o.clicca("Dispositivi");
  v("commento_pn_mostrato", o.testi().includes("azionamento nastro 1"));
  await o.clicca("sew-movimot-1");
  v("editor_commento_pn", o.testi().includes("Commento: sew-movimot-1"));
  for (let i = 0; i < 25; i++) await o.clicca("Canc");
  await o.scrivi("nastro 1"); await o.clicca("Salva"); await pausa(30);
  v("commento_pn_inviato", o.richieste.some(r => r.percorso === "/api/pannello/commento" && r.campi.tipo === "profinet"
                                              && r.campi.indice === "1" && r.campi.testo === "nastro 1"));
  await o.clicca("Rete");
  t = o.testi();
  v("rete_dal_registratore", t.includes("192.168.0.50") && t.includes("da approvare") && t.includes("questo PC") && t.includes("A4:5E:60:AA:BB:CC"));
  await o.clicca("da approvare"); await o.clicca("Approva"); await pausa(30);
  v("approva_inviato", o.richieste.some(r => r.percorso === "/api/pannello/approva" && r.campi.ip === "192.168.0.50" && r.token === TOKEN));
  await o.clicca("PLC"); await o.clicca("Revoca"); await pausa(30);
  v("revoca_inviata", o.richieste.some(r => r.percorso === "/api/pannello/revoca" && r.campi.ip === "192.168.0.1"));

  // 6. registratore assente o con token sbagliato
  o = crea({ registratoreSpento: true }); await pausa(30); await o.ciclo(); await o.registratore();
  v("registratore_assente", o.testi().includes("rete esterna non controllata (registratore non raggiungibile)"));
  await o.clicca("Dispositivi"); await o.clicca("Rete");
  v("rete_non_raggiungibile", o.testi().includes("Registratore non raggiungibile: errore curl 7."));
  o = crea({ tokenRegistratore: "altro" }); await pausa(30); await o.ciclo(); await o.registratore();
  await o.clicca("Dispositivi"); await o.clicca("Rete");
  v("token_errato", o.testi().includes("Registratore non raggiungibile: token errato."));

  // 7. lettura divisa, comandi non abilitati, guasti
  o = crea({ diviso: true }); await pausa(20); await o.ciclo();
  await o.clicca("Dispositivi");
  v("lettura_divisa", o.testi().includes("sew-movimot-1"));
  o = crea({ prepara: db => { db[12] &= ~32; db[1322] = 8; } }); await pausa(20); await o.ciclo();
  v("cpu_diversa", o.testi().includes("CPU diversa da quella approvata"));
  o = crea({ abilita: false, registratore: reteEsterno }); await pausa(30); await o.ciclo(); await o.registratore();
  await o.clicca("Approva programma");
  await o.clicca("Dispositivi"); await o.clicca("Rete");
  try { await o.clicca("da approvare"); } catch (x) { /* non e' un pulsante */ }
  v("non_abilitato", !o.scritture.some(a => a.bit !== undefined) && !o.richieste.some(r => r.percorso === "/api/pannello/approva"));
  o = crea({ guasto: true }); await pausa(20); await o.ciclo();
  v("guasto", o.testi().includes("dbStato (35 parole): cannot get data"));
  o = crea({ vitaFerma: true }); await pausa(20); await o.ciclo(6);
  v("vita_ferma", o.testi().includes("FB_SigilloBase non in esecuzione"));

  // 8. stato della CPU: RUN dedotto dalla vita, tempi di ciclo, avvii, azzeramento
  const pnOnline = db => { db[1380] |= 0b110; };
  o = crea({ prepara: pnOnline, registratoreSpento: true }); await pausa(20); await o.ciclo(2);
  await o.clicca("CPU");
  t = o.testi();
  v("cpu_run_dalla_vita", t.includes("RUN (dedotto dal contatore di vita)"));
  v("cpu_ciclo_e_avvii", /\d\.\d ms/.test(t) && t.includes("Numero di avvii") && t.includes(" | 3 | ") && /CPU (allineata|indietro di 1 s)/.test(t));
  await o.clicca("Azzera minimo e massimo");
  v("cpu_azzera", (o.db[1854] & 1) === 1);
  await o.clicca("Stato");
  v("cpu_riga_stato", /RUN, ciclo \d/.test(o.testi()));
  // RUN / STOP preciso dal registratore
  o = crea({ vitaFerma: true, registratore: { cpu: { modo: "STOP" } } }); await pausa(30); await o.registratore(); await o.ciclo(6);
  v("cpu_stop_dal_registratore", o.testi().includes("CPU in STOP") && !o.testi().includes("FB_SigilloBase non in esecuzione"));
  o = crea({ vitaFerma: true, registratore: { cpu: { modo: "RUN" } } }); await pausa(30); await o.registratore(); await o.ciclo(6);
  v("cpu_run_fb_fermo", o.testi().includes("La CPU è in RUN ma il contatore di vita è fermo"));
  await o.clicca("CPU");
  v("cpu_fb_fermo_scheda", o.testi().includes("RUN, ma FB_SigilloBase fermo (letto dal registratore)") && o.testi().includes("– (FB fermo)"));
  // il contatore di vita e' piu' fresco del registratore: se si muove la CPU e' in RUN
  o = crea({ prepara: pnOnline, registratore: { cpu: { modo: "STOP" } } }); await pausa(30); await o.registratore(); await o.ciclo(2);
  v("cpu_vita_piu_fresca", !o.testi().includes("CPU in STOP"));
  // orologio della CPU indietro di un'ora
  o = crea({ prepara: db => { pnOnline(db); db[1834 + 5] = (db[1834 + 5] + 23) % 24; } }); await pausa(30); await o.ciclo(2);
  v("cpu_ora_errata", o.testi().includes("Orologio della CPU sbagliato") && o.testi().includes("indietro di 60 min"));
  // dbCpu non configurato: RUN/STOP resta, con la spiegazione
  o = crea({ senzaCpu: true }); await pausa(20); await o.ciclo(2);
  await o.clicca("CPU");
  v("cpu_non_configurata", o.testi().includes("RUN (dedotto dal contatore di vita)") && o.testi().includes("non configurato"));
  console.log(JSON.stringify(e));
})().catch(x => console.log(JSON.stringify({ eccezione: String(x.stack || x) })));
