# Sigillo Base v2.2

Rileva le modifiche al programma PLC, alla firma del programma di sicurezza e all'hardware (CPU
sostituita o firmware aggiornato), registra apertura del quadro e modalità manutenzione, sorveglia
16 parametri con limiti minimo/massimo, blocca l'avvio automatico finché le modifiche non vengono
approvate e conserva tutto in un registro a prova di manomissione. Tiene sotto controllo i
dispositivi della macchina e della rete e lo stato della CPU (RUN/STOP, tempo di ciclo, avvii) e mostra ingressi e uscite.

```
plc/           1_SigilloBase_Evento.udt, 2_DB_SigilloBase.db, 3_FC_SigilloBaseEvento.scl, 4_FB_SigilloBase.scl
weintek/       SigilloBase_JSObject.js (pagina per cMT-X), anteprima.png
registratore/  sigillo_base.py, collegamenti.py, static/ (pagina web e verificatore), tests/
```

## Chi tiene cosa

| Dato | Dove sta |
| --- | --- |
| Stato del programma, checksum, firma F, CPU, eventi, parametri e limiti | PLC (`DB_SigilloBase`) |
| Dispositivi PROFINET configurati/presenti e loro nomi (letti da TIA con Get_Name) | PLC |
| Elenco dei dispositivi Ethernet controllati dal pannello (IP, porta, nome) | memoria ritentiva del pannello (RW) |
| Elenco della rete, IP, MAC, approvazioni, commenti, storico permanente | registratore |

Il DB del PLC è di **1856 byte** (1822 della v2.0 più 34 per lo stato della CPU). Il registratore non
scrive nulla nel PLC: il pannello lo interroga direttamente via HTTP.

> **Aggiornamento dalla v2.1:** cambia solo il JS Object del pannello. PLC, DB e registratore restano
> quelli della v2.1. Incolla il nuovo codice e, se vuoi la scheda **Registro**, aggiungi `dbEventi` nella
> Config. Il pannello legge meno dal PLC e ridisegna lo schermo solo quando qualcosa cambia
> (vedi [Carico sul pannello](#carico-sul-pannello)).

> **Aggiornamento dalla v2.0:** reimporta DB e FB e ricarica il DB: la struttura `Cpu` si aggiunge in
> fondo, ma un DB ad accesso standard non ha riserva di memoria, quindi il caricamento lo reinizializza
> (il riferimento si azzera: riapprova il programma; il contatore degli avvii riparte da 1). Sul pannello
> aggiungi `dbCpu` (e, se vuoi, `cpuAzzera`) nella Config e incolla il nuovo codice. Il registratore
> v2.1 legge 1856 byte: aggiorna PLC e registratore insieme.

> **Aggiornamento dalla v1.x:** reimporta DB e FB, ricarica il DB (il riferimento si azzera) e
> riapprova il programma. Sul pannello cambiano la Config e il codice (vedi sotto). Nel tuo FB,
> la scansione dei nomi PROFINET con Get_Name è stata integrata e scrive in `PnNomi`: la struttura
> `DatiDispositivi` e il DB `COLLAUDO` non servono più.

## 1. PLC (TIA Portal)

1. In **Sorgenti esterne** genera i blocchi uno alla volta in ordine: UDT, DB, FC, FB.
2. `DB_SigilloBase`: numero libero (nell'esempio DB6), **accesso standard**, **a ritenzione**.
   Nella CPU abilita **PUT/GET**.
3. Crea `DB_Parametri` con `Valori : Array[1..16] of Real`: la macchina deve usare quei valori.
4. Chiamata in OB1, una sola volta:

```
"FB_SigilloBase_DB"(PeriodoControllo := T#10S,
                    FirmaF := 16#0,                               // CPU F: firma da F_SYST_INFO
                    BloccaAvvio := FALSE,                          // TRUE dopo la messa in servizio
                    QuadroAperto := "I_PortaQuadro",               // FALSE se non c'è
                    ChiaveManutenzione := "I_SelManut",            // FALSE se non c'è
                    LaddrCpu := "Local~Common",                    // HW ID della CPU
                    LaddrIoSystem := "Local~PROFINET_IO-System",   // IO-System PROFINET; 0 se non c'è
                    Parametri := "DB_Parametri".Valori,
                    AvvioConsentito => "M_AvvioConsentito",
                    Allarme => "M_SigilloAllarme");
```

`AvvioConsentito` va in AND con il consenso al ciclo automatico. Non è una funzione di sicurezza.

**Nomi PROFINET.** Dopo l'avvio, e ogni volta che il pannello preme "Rileggi da TIA", il FB legge
con Get_Name il nome di ogni dispositivo configurato (numeri 1..16) e lo scrive in `PnNomi`.
Get_Name non ha REQ: viene chiamato a ogni ciclo mentre legge un dispositivo, e il nome viene
accettato solo dopo che l'istruzione ha lavorato davvero (BUSY, oppure dalla terza chiamata),
per non prendere il risultato del dispositivo precedente. Ogni dispositivo ha 3 s di tempo massimo.

### Indirizzi per l'HMI (DB6)

| Dato | Offset | Tipo |
| --- | --- | --- |
| Approva / Sblocca avvio | 10.0 / 10.1 | Bool |
| Minimo / massimo / attivo parametro n | 1094 + 10(n−1) / +4 / +8.0 | Real / Real / Bool |
| Valore attuale parametro n | 1254 + 4(n−1) | Real |
| Rileggi nomi PROFINET | 1402.0 | Bool |
| Tempo di ciclo attuale / minimo / massimo [ms] | 1822 / 1826 / 1830 | Real |
| Ora della CPU | 1834 | DTL |
| Numero di avvii / secondi dall'ultimo avvio | 1846 / 1850 | DInt |
| Azzera minimo e massimo del ciclo | 1854.0 | Bool |

## 2. Pannello Weintek (JS Object, cMT-X)

1. JS Object di almeno 640 x 400, interamente visibile. Incolla `SigilloBase_JSObject.js`.
2. In cima al file imposta:
   - `REGISTRATORE`: indirizzo del PC del registratore (es. `http://192.168.0.50:8150`) e lo
     stesso `token_pannello` scritto nel `config.json` del registratore. `url: ""` = senza registratore;
   - `NOMI_PARAMETRI`: i nomi dei 16 parametri.
3. Scheda **Config**, Tipo = **Tags** (assoluti: senza "Tag di progetto", 16-bit Unsigned):

| Nome | Indirizzo (DB6) | Conteggio |
| --- | --- | --- |
| `dbStato` | `60000` | 35 |
| `dbEst` | `61094` | 135 |
| `dbPn` | `61364` | 229 |
| `ethStato` | `61396` | 3 |
| `dbCpu` | `61822` | 17, facoltativo (scheda CPU) |
| `dbEventi` | `60070` | 512, facoltativo (scheda Registro) |
| `ioIngressi` | area **I** (ingressi), dal byte `IO.ingressi` (es. `0`) | `IO.paroleIngressi` (es. 4 = IB0..IB7), facoltativo (scheda I/O) |
| `ioUscite` | area **Q** (uscite), dal byte `IO.uscite` (es. `0`) | `IO.paroleUscite` (es. 4 = QB0..QB7), facoltativo (scheda I/O) |
| `ethMemoria` | **Local HMI**, `RW-1000` (registri ritentivi del pannello) | 192 |
| `cmdApprova` | tag `DB_SigilloBase.Cmd.ImpostaRiferimento` | Bit |
| `cmdSblocca` | tag `DB_SigilloBase.Cmd.SbloccaAvvio` | Bit |
| `pnRileggi` | tag `DB_SigilloBase.PnCmd.Rileggi` | Bit, facoltativo |
| `cpuAzzera` | tag `DB_SigilloBase.Cpu.AzzeraCiclo` | Bit, facoltativo |
| `abilitaComandi` | bit interno, es. LB-9000 | facoltativo |

`ethMemoria` occupa 192 parole a partire dall'indirizzo scelto (RW-1000..RW-1191): non usarle per
altro. Se un blocco lungo dà "cannot get data", dividilo: `dbPn` 62 + `dbPn2` (`61488`, 62) +
`dbPn3` (`61612`, 62) + `dbPn4` (`61736`, 43); `dbEst` 62 + `dbEst2` (`61218`, 62) + `dbEst3` (`61342`, 11);
`dbEventi` 62 + `dbEventi2` (`60194`, 62) … `dbEventi8` (`60938`, 62) + `dbEventi9` (`61062`, 16).

**Schede**
- **Stato**: programma, firma F, CPU, quadro, manutenzione, avvio, riepilogo dei collegamenti.

In cima, sopra ogni scheda, ci sono **due fasce**, ognuna con il proprio colore. Così un problema non ne
nasconde un altro:
1. **programma e CPU**: approvato / modificato / avvio bloccato / CPU diversa / CPU in STOP;
2. **dispositivi**: dispositivi offline, esterni sulla rete, accesso alla CPU.
- **Parametri**: valori e limiti.
- **Dispositivi → Macchina**: dispositivi PROFINET con il nome letto da TIA e dispositivi Ethernet
  con IP e porta, stato online/offline e commento. "Aggiungi dispositivo Ethernet" apre l'editor con
  tastiera; toccando un dispositivo Ethernet lo si modifica o cancella, toccando un PROFINET si scrive
  il suo commento. "Rileggi da TIA" rilegge i nomi PROFINET. Funziona anche senza registratore
  (senza commenti).
- **Dispositivi → Rete**: elenco del registratore (IP, nome, MAC, stato, commento). Toccando un
  dispositivo non noto lo si approva; toccando un noto lo si commenta o se ne revoca l'approvazione.
- **CPU**: RUN/STOP con la sua fonte, tempo di ciclo attuale, minimo e massimo (pulsante "Azzera
  minimo e massimo" se c'è `cpuAzzera`), tempo dall'ultimo avvio e numero di avvii. Data e ora del
  PLC non si mostrano. Vedi [Stato della CPU](#stato-della-cpu).
- **I/O** (solo se nella Config c'è `ioIngressi` o `ioUscite`): ingressi a sinistra e uscite a destra,
  una riga per byte e una casella per bit, verde quando il bit è a 1. Toccando una casella compaiono il
  suo indirizzo, il nome scritto in `NOMI_IO` (es. `"I0.0": "Emergenza"`) e il valore. Ingressi e uscite
  si leggono direttamente dalle aree I e Q della CPU, quindi **non occupano nulla nel DB**. Si leggono
  solo con la scheda aperta (massimo 16 parole per area). Il pannello non scrive le uscite.
- **Registro**: gli ultimi 32 eventi del PLC (quelli del buffer `Eventi` nel DB), dal più recente, con
  numero, data e ora della CPU e descrizione (nomi dei parametri, dei dispositivi PROFINET ed Ethernet).
  Si sfoglia a pagine con "Più recenti" / "Meno recenti". Con un'altra scheda aperta, l'etichetta
  mostra quanti eventi nuovi sono arrivati, es. "Registro (2)". Lo storico completo resta nel
  registratore; la scheda funziona anche senza.

Tutti i comandi richiedono `abilitaComandi` a 1.

## 3. Registratore (PC sulla rete della macchina)

```
cd registratore
pip install -r requirements.txt
copy config.example.json config.json        (Linux: cp)
python sigillo_base.py avvia --config config.json
```

In `config.json`:

```json
"plc": { "ip": "192.168.0.1", "rack": 0, "slot": 1, "db": 6 },
"pin_dispositivi": "1234",
"token_pannello": "cambia-questa-chiave",
"rete": { "abilitato": true, "sottorete": "192.168.0.0/24", "periodo_s": 15,
          "noti": { "192.168.0.1": { "nome": "PLC", "mac": "" } } }
```

`pin_dispositivi` serve per approvare e commentare dalla pagina web; `token_pannello` deve essere
uguale a `REGISTRATORE.token` nel JS Object.

`sottorete` accetta anche un elenco (`"sottoreti": ["192.168.0.0/24", "192.168.1.0/24"]`).
Nel firewall di Windows consenti a Python le connessioni in ingresso sulla porta **8150** (pannello)
e su **UDP 514** se usi il Syslog.

Pagina web `http://localhost:8150`, sezione **Collegamenti**: dispositivi della rete e della
macchina con commenti (pulsante Commenta, chiede nome e PIN), approvazioni, e una riga di
diagnostica con le sottoreti controllate, quanti dispositivi hanno risposto all'ultima scansione e
gli indirizzi di questo PC.

### Se un PC collegato alla rete non viene rilevato

1. **È lo stesso PC del registratore?** Allora compare come **"Questo PC"** (noto, non come
   esterno): è il registratore stesso. Per provare il rilevamento collega un **altro** PC.
2. **Il PC ha un IP nella sottorete controllata?** Guarda la riga di diagnostica: se l'IP del PC
   esterno è in un'altra sottorete (es. 192.168.1.x mentre controlli 192.168.0.0/24), aggiungila in
   `sottoreti`.
3. **Il registratore vede la rete?** Se "dispositivi che hanno risposto" è 0, il PC del registratore
   non è sulla rete macchina o l'IP della sua scheda è in un'altra sottorete.
4. Il nuovo dispositivo compare entro una scansione (circa 15 s) e viene registrato come
   "Dispositivo non noto collegato alla rete macchina".

### Eventi di sicurezza della CPU (Syslog)

```json
"syslog": { "abilitato": true, "porta": 514, "sorgenti": ["192.168.0.1"], "accesso_minuti": 5 }
```

Il registratore riceve i messaggi Syslog (UDP 514) che arrivano dall'IP della CPU e li registra
così come sono. I messaggi che parlano di login, sessioni o connessioni accendono per 5 minuti
"Accesso alla CPU segnalato" sul pannello.

- **Da verificare sulla CPU:** non tutti i modelli e firmware inviano eventi Syslog. Nelle
  proprietà della CPU in TIA cerca la voce Syslog / registrazione degli eventi di sicurezza e
  indica come server l'IP del PC del registratore. Se la voce non c'è, la CPU non lo supporta e
  resta valido il controllo sulla rete.
- Nel firewall di Windows consenti a Python le connessioni in ingresso su **UDP 514**.
- Dopo la prova al banco mandami i messaggi ricevuti: affiniamo il riconoscimento degli accessi
  sul testo reale della tua CPU.

## Stato della CPU

Cosa si può sapere in modo affidabile:

- **RUN o STOP**: il registratore lo legge direttamente dalla CPU con snap7. Il pannello lo deduce dal
  contatore di vita, e lo riceve preciso dal registratore quando è attivo.
- **Tempo di ciclo** attuale, minimo e massimo, misurato dal FB con l'istruzione `RUNTIME`.
- **Tempo dall'ultimo avvio** e **numero di avvii** della CPU.

Dettagli:

- **RUN/STOP dal registratore.** Il registratore legge il modo operativo dalla lista di stato della CPU
  (SZL 0x0424) con `read_szl`. Non usa `get_cpu_state()`: con python-snap7 3.x restituisce sempre RUN
  senza interrogare la CPU (lo usa solo come riserva con snap7 1.x/2.x). Registra "CPU in STOP" e
  "CPU di nuovo in RUN". Se la CPU è in RUN ma il contatore di vita è fermo, registra "FB_SigilloBase
  non in esecuzione (CPU in RUN)": il FB non viene chiamato.
  **Da verificare al banco:** nella pagina web, alla voce "Modo (snap7)", compare il byte bzu-id letto
  dalla CPU (08 = RUN). Metti la CPU in STOP e controlla che la pagina indichi STOP; se non succede,
  mandami il valore del byte.
- **RUN/STOP sul pannello.** Il contatore di vita che si muove vuol dire RUN. Il contatore fermo vuol dire
  CPU in STOP *oppure* FB non chiamato: da solo il pannello non può distinguere i due casi, e lo
  scrive. Con il registratore raggiungibile riceve il modo preciso. Se il contatore si muove, vale
  RUN anche se il registratore riporta ancora STOP: il contatore è il dato più fresco.
- **Tempo di ciclo.** `RUNTIME` misura il tempo tra due chiamate del FB, quindi il ciclo dell'OB che lo
  chiama (OB1). Minimo e massimo valgono dall'ultimo avvio o dall'ultimo azzeramento; le prime due misure
  dopo l'avvio si scartano.
- **Ora.** Il FB copia ancora l'ora della CPU nel DB (byte 1834), ma né il pannello né il registratore
  la mostrano o la controllano.
- **Avvii.** Il contatore sta nel DB a ritenzione e cresce a ogni avvio. Il numero compare anche
  nell'evento 1 del registro ("avvio n. 12"). Il tempo dall'ultimo avvio è la somma dei tempi di ciclo:
  non dipende dall'orologio della CPU.

### Cosa scrive il registratore nel PLC

## Carico sul pannello

Il JS Object è scritto per pesare il meno possibile sul cMT-X:

- **Ridisegno solo se serve.** A ogni lettura il pannello prepara l'elenco di quello che andrebbe
  disegnato e lo confronta con quello già sullo schermo: se è uguale non tocca il Canvas. Le schede
  Stato, Dispositivi e Registro, ferme, non si ridisegnano; CPU e Parametri si ridisegnano quando un
  valore cambia. Per questo la riga "Stato della CPU" della scheda Stato non mostra più il tempo di
  ciclo, che cambia a ogni lettura: è nella scheda CPU.
- **Larghezze dei testi in memoria.** Le misure dei testi e i testi accorciati con "…" si calcolano una
  volta sola.
- **Letture ridotte.** Ogni secondo si leggono `dbStato` (35 parole) e i primi 20 word di `dbPn` (quali
  dispositivi PROFINET sono configurati e presenti). `dbEst` si legge ogni secondo con le schede Stato e
  Parametri aperte, `dbCpu` con la scheda CPU, `dbEventi` con la scheda Registro e solo quando arriva
  un evento nuovo; tutto il resto ogni 10 s. Cambiando scheda il pannello rilegge subito tutto. Dopo
  "Rileggi da TIA" i nomi PROFINET si rileggono ogni secondo per un minuto.

| Al secondo, nel banco di prova | v2.1 | v2.2 |
| --- | --- | --- |
| Parole lette dal PLC, scheda Stato / Dispositivi / CPU | 416 / 416 / 416 | 213 / 91 / 106 |
| Ridisegni del Canvas con la scheda ferma | 1 | 0 |

## Eventi registrati

| N. | Evento |
| --- | --- |
| 1 | Avvio o reinizializzazione del programma PLC (con il numero dell'avvio) |
| 2 | Programma e hardware approvati |
| 3 / 4 | Programma diverso dall'approvato / tornato uguale |
| 5 | Firma F cambiata |
| 6 / 7 | Avvio automatico bloccato / sbloccato |
| 8 | Errore lettura checksum |
| 9 | CPU diversa dall'approvata (firmware o seriale) |
| 10 / 11 | Quadro aperto / chiuso |
| 12 / 13 | Manutenzione inserita / disinserita |
| 14 | Parametro modificato (valore prima e dopo) |
| 15 | Valore fuori limite rifiutato |
| 16 | Limiti di un parametro modificati |
| 17 | Firmware e seriale CPU non leggibili |
| 18 / 19 | Dispositivo PROFINET offline / di nuovo online (con il nome letto da TIA) |
| 20 / 21 | Dispositivo Ethernet offline / di nuovo online (controllo del pannello) |
| 26 | Nome PROFINET non leggibile |
| registratore | Rete: dispositivi noti online/offline, non noti collegati/scollegati, MAC diverso, approvazioni, revoche |
| registratore | Commenti, elenco Ethernet del pannello cambiato, token o PIN errati, Syslog della CPU |
| registratore | CPU in STOP / di nuovo in RUN, FB non in esecuzione con CPU in RUN |

## Test

```
pip install pytest
python -m pytest -q tests
```

Il banco `tests/banco_jsobject.js` esegue il JS Object con Canvas, driver, memoria RW del pannello,
dispositivi Ethernet e registratore HTTP simulati (67 scenari, compresi il carico sul pannello, le
schede Registro e I/O e le due fasce di stato).
