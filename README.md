# SplitTimer (PWA) – nasazení na GitHub Pages

Toto je statická PWA (webová aplikace), která běží na iPhonu v režimu „Přidat na plochu“ jako samostatná aplikace.
Data se ukládají lokálně v zařízení (localStorage). Má export/import JSON.

## Struktura
- index.html – obrazovky a modaly
- style.css – vzhled
- app.js – logika (tratě, checkpointy, stopky, GPX import, profil, žebříček)
- manifest.webmanifest – PWA manifest
- sw.js – Service Worker (offline)
- icons/ – ikony

## Doporučené nasazení
GitHub Pages (HTTPS) – ideální pro iOS PWA.

## Poznámka k aktualizacím
PWA cachuje soubory přes `sw.js`. Když nasadíš novou verzi, může být potřeba:
- na iPhonu otevřít web a jednou obnovit (pull-to-refresh),
- případně odstranit a znovu přidat na plochu, pokud se dlouho neprojeví změny.


---

## (Volitelné) Automatická synchronizace do Google Sheets (Apps Script)

Aplikace umí **automaticky synchronizovat výsledky jízd (rides) + trasy + checkpointy** do Google Sheets přes Google Apps Script.
Protože GitHub Pages je čistě statický hosting a Apps Script standardně neumožňuje jednoduché CORS hlavičky,
používá aplikace **JSONP (doGet + callback)**.

### 1) Nastav API URL a SECRET (už je vyplněno v kódu)
V souboru `app.js` jsou nastaveny tyto konstanty:

- `SHEETS_API_URL` = tvoje URL web aplikace Apps Script
- `SHEETS_API_SECRET` = `st_pRrN8e6Lgkh2A5SThDEKpek4qZZL_0pr`

> DŮLEŽITÉ: Stejný secret musí být i v Apps Script kódu (`API_SECRET`).

### 2) Apps Script – vlož tento kód do `Code.gs`
V Apps Script projektu nahraď obsah `Code.gs` tímto (nebo uprav tak, aby podporoval `doGet` s `action`, `payload`, `callback`):

```javascript
const API_SECRET = "st_pRrN8e6Lgkh2A5SThDEKpek4qZZL_0pr";

function jsonp_(callbackName, obj) {
  const out = (callbackName || "callback") + "(" + JSON.stringify(obj) + ")";
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function ok_(callbackName, extra) {
  return jsonp_(callbackName, Object.assign({ ok: true }, extra || {}));
}

function err_(callbackName, msg) {
  return jsonp_(callbackName, { ok: false, error: String(msg || "Error") });
}

function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  const callback = p.callback;
  const secret = p.secret;
  if (secret !== API_SECRET) return err_(callback, "Bad secret");

  const action = p.action || "";
  let payload = {};
  try {
    payload = p.payload ? JSON.parse(p.payload) : {};
  } catch (ex) {
    return err_(callback, "Bad payload JSON");
  }

  try {
    if (action === "upsertRoute") return ok_(callback, upsertRoute_(payload));
    if (action === "replaceCheckpoints") return ok_(callback, replaceCheckpoints_(payload));
    if (action === "insertRide") return ok_(callback, insertRide_(payload));
    return err_(callback, "Unknown action: " + action);
  } catch (ex) {
    return err_(callback, ex);
  }
}

function sheet_() {
  // TODO: sem dej ID nebo název tabulky – nejjednodušší je otevřít aktivní Spreadsheet
  return SpreadsheetApp.getActiveSpreadsheet();
}

function upsertRoute_(p) {
  const ss = sheet_();
  const sh = ss.getSheetByName("Routes") || ss.insertSheet("Routes");
  const headers = ["routeId","source","name","totalDistanceKm","totalAscentM","difficulty"];
  ensureHeaders_(sh, headers);

  const rows = sh.getDataRange().getValues();
  const idx = rows.findIndex((r,i)=>i>0 && String(r[0])===String(p.routeId));
  const row = [p.routeId, p.source, p.name, p.totalDistanceKm, p.totalAscentM, p.difficulty];

  if (idx > 0) {
    sh.getRange(idx+1, 1, 1, headers.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
  return {};
}

function replaceCheckpoints_(p) {
  const ss = sheet_();
  const sh = ss.getSheetByName("Checkpoints") || ss.insertSheet("Checkpoints");
  const headers = ["routeId","checkpointId","order","name","distanceKm"];
  ensureHeaders_(sh, headers);

  // delete existing checkpoints for routeId
  const values = sh.getDataRange().getValues();
  const keep = [values[0]];
  for (let i=1;i<values.length;i++) {
    if (String(values[i][0]) !== String(p.routeId)) keep.push(values[i]);
  }
  sh.clearContents();
  sh.getRange(1,1,keep.length,headers.length).setValues(keep);

  // add new
  (p.checkpoints || []).forEach(cp => {
    sh.appendRow([p.routeId, cp.checkpointId, cp.order, cp.name, cp.distanceKm]);
  });
  return {};
}

function insertRide_(p) {
  const ss = sheet_();
  const sh = ss.getSheetByName("Rides") || ss.insertSheet("Rides");
  const headers = ["rideId","routeId","source","dateISO","label","note","finishMs","splitsJson","deviceId","appVersion"];
  ensureHeaders_(sh, headers);

  // prevent duplicate rideId
  const rows = sh.getDataRange().getValues();
  const exists = rows.some((r,i)=>i>0 && String(r[0])===String(p.rideId));
  if (!exists) {
    sh.appendRow([
      p.rideId, p.routeId, p.source, p.dateISO, p.label, p.note,
      p.finishMs, JSON.stringify(p.splits || []), p.deviceId, p.appVersion
    ]);
  }
  return {};
}

function ensureHeaders_(sh, headers) {
  const row1 = sh.getRange(1,1,1,headers.length).getValues()[0];
  const ok = headers.every((h,i)=>String(row1[i]||"")===h);
  if (!ok) {
    sh.clearContents();
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  }
}
```

### 3) Nasazení Apps Script jako Web App
- **Deploy → New deployment → Web app**
- Execute as: **Me**
- Who has access: **Anyone** (nebo Anyone with link)
- Zkopíruj URL `/exec` a ověř, že je stejná jako `SHEETS_API_URL`

### Jak funguje auto-sync v aplikaci
- Po uložení výsledku se jízda uloží lokálně **a** zařadí se do fronty (`pendingSync`)
- Při připojení k internetu se synchronizace zkusí znovu automaticky (také při startu aplikace)

