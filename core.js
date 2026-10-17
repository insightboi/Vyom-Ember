/* Pure data and scoring logic shared by the browser and Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EmberCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DISTANCE_KM = 5;
  const REPEAT_WINDOW_HOURS = 24;
  const STALE_AFTER_HOURS = 24;
  const HEADER_ALIASES = {
    latitude: ['latitude', 'lat'], longitude: ['longitude', 'lon', 'long', 'lng'],
    timestamp: ['observedutc', 'observed', 'timestamp', 'datetime', 'acqdatetime', 'acquisitiondatetime'],
    date: ['acqdate', 'acquisitiondate'], time: ['acqtime', 'acquisitiontime'],
    confidence: ['confidence', 'conf'], frp: ['frp', 'frpmw', 'fireradiativepower'],
    brightness: ['brightness', 'brightt31', 'brightti4', 'brightt4'],
    satellite: ['satellite', 'instrument'], place: ['place', 'location', 'region'],
    id: ['id', 'observationid', 'obsid']
  };
  const cleanHeader = value => value.replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function parseRows(text) {
    const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') { quoted = false; afterQuote = true; }
        else cell += ch;
      } else if (afterQuote) {
        if (ch === ',') { row.push(cell); cell = ''; afterQuote = false; }
        else if (ch === '\n' || ch === '\r') { row.push(cell); rows.push(row); row = []; cell = ''; afterQuote = false; if (ch === '\r' && text[i + 1] === '\n') i++; }
        else if (ch === ' ' || ch === '\t') { /* allow padding after a quoted field */ }
        else return { rows: [], syntaxError: `Unexpected character after closing quote at character ${i + 1}.` };
      } else if (ch === '"') {
        if (cell.trim()) return { rows: [], syntaxError: `Unexpected quote in an unquoted field at character ${i + 1}.` };
        cell = ''; quoted = true;
      } else if (ch === ',') { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n' || ch === '\r') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; if (ch === '\r' && text[i + 1] === '\n') i++; }
      else cell += ch;
    }
    if (quoted) return { rows: [], syntaxError: 'CSV ends inside a quoted field.' };
    if (cell.length || row.length) { row.push(afterQuote ? cell : cell.trim()); rows.push(row); }
    return { rows };
  }

  function strictTimestamp(value, acqTime) {
    const raw = String(value || '').trim();
    let iso = raw;
    if (/^\d{8}$/.test(raw)) {
      if (!acqTime) return null;
      const t = String(acqTime).trim().replace(':', '').padStart(4, '0');
      if (!/^\d{4}$/.test(t)) return null;
      iso = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:00Z`;
    } else if (/^\d{8}T\d{4}$/.test(raw)) {
      iso = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(9,11)}:${raw.slice(11,13)}:00Z`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      if (acqTime) {
        const t = String(acqTime).trim().replace(':', '').padStart(4, '0');
        if (!/^\d{4}$/.test(t) || Number(t.slice(0, 2)) > 23 || Number(t.slice(2, 4)) > 59) return null;
        iso = `${raw}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
      } else iso = `${raw}T12:00:00Z`;
    } else if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const datePart = iso.slice(0, 10), timePart = iso.slice(11, 19);
    const check = new Date(`${datePart}T${timePart}Z`);
    if (check.toISOString().slice(0, 19) !== `${datePart}T${timePart}`) return null;
    return new Date(ms).toISOString();
  }

  function parseCSV(text) {
    const parsed = parseRows(String(text));
    if (parsed.syntaxError) return { rows: [], errors: [{ rowNumber: 1, reasons: [parsed.syntaxError] }], headerErrors: [] };
    const lines = parsed.rows.filter((r, i) => !(i === parsed.rows.length - 1 && r.length === 1 && !r[0].trim()));
    if (!lines.length) return { rows: [], errors: [], headerErrors: ['CSV is empty.'] };
    const headers = lines[0].map(cleanHeader), idx = key => headers.findIndex(h => HEADER_ALIASES[key].includes(h));
    const col = { latitude: idx('latitude'), longitude: idx('longitude'), timestamp: idx('timestamp'), date: idx('date'), time: idx('time'), confidence: idx('confidence'), frp: idx('frp'), brightness: idx('brightness'), satellite: idx('satellite'), place: idx('place'), id: idx('id') };
    const headerErrors = [];
    for (const [key,label] of [['latitude','latitude'],['longitude','longitude'],['confidence','confidence'],['frp','FRP']]) if (col[key] < 0) headerErrors.push(`Missing required ${label} column.`);
    if (col.timestamp < 0 && (col.date < 0 || col.time < 0)) headerErrors.push('Missing timestamp column (use a timestamp or both acq_date and acq_time).');
    if (headers.includes('acqdate') && col.time < 0) headerErrors.push('Missing acq_time column for FIRMS acq_date values.');
    if (headerErrors.length) return { rows: [], errors: [], headerErrors };
    const valid = [], errors = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]; if (cells.every(v => !String(v ?? '').trim())) continue;
      const get = key => col[key] >= 0 ? String(cells[col[key]] ?? '').trim() : '';
      const reasons = [], number = (key,label,min,max) => {
        const value = get(key); if (!value) { reasons.push(`${label} is blank.`); return NaN; }
        const n = Number(value); if (!Number.isFinite(n)) { reasons.push(`${label} must be a number.`); return NaN; }
        if (n < min || n > max) reasons.push(`${label} must be between ${min} and ${max}.`);
        return n;
      };
      const latitude = number('latitude','Latitude',-90,90), longitude = number('longitude','Longitude',-180,180), confidenceText=get('confidence');
      let confidence = NaN;
      if (!confidenceText) reasons.push('Confidence is blank.');
      else if (/^(high|h)$/i.test(confidenceText)) confidence=90;
      else if (/^(nominal|medium|n)$/i.test(confidenceText)) confidence=65;
      else if (/^(low|l)$/i.test(confidenceText)) confidence=30;
      else { confidence=Number(confidenceText); if (!Number.isFinite(confidence)) reasons.push('Confidence must be numeric (0–100) or Low/Nominal/High (including FIRMS l/n/h).'); else if (confidence<0||confidence>100) reasons.push('Confidence must be between 0 and 100.'); }
      const frp = number('frp','FRP',0,Number.MAX_VALUE);
      const rawTime = col.timestamp >= 0 ? get('timestamp') : get('date');
      const observed = strictTimestamp(rawTime, col.time>=0 ? get('time') : '');
      if (!rawTime) reasons.push('Timestamp is blank.'); else if (!observed) reasons.push('Timestamp is malformed or invalid; use ISO 8601 with timezone or FIRMS acquisition date and time.');
      const brightnessText=get('brightness'), brightness=brightnessText ? Number(brightnessText) : null;
      if (brightnessText && !Number.isFinite(brightness)) reasons.push('Brightness must be a number when provided.');
      if (reasons.length) { errors.push({ rowNumber:i+1, reasons }); continue; }
      const confidenceLabels={high:'High',h:'High',nominal:'Nominal',medium:'Nominal',n:'Nominal',low:'Low',l:'Low'};
      valid.push({ id:get('id')||`OBS-${String(valid.length+1).padStart(4,'0')}`, place:get('place')||`Detection ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`, latitude, longitude, observed, satellite:get('satellite')||'Unknown satellite', confidence, confidenceReported:confidenceText, confidenceLabel:confidenceLabels[confidenceText.toLowerCase()]||null, brightness, frp, sourceRow:i+1 });
    }
    return { rows: valid, errors, headerErrors };
  }

  function distanceKm(a,b) {
    const rad=Math.PI/180, dLat=(b.latitude-a.latitude)*rad,dLon=(b.longitude-a.longitude)*rad;
    const x=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLon/2)**2;
    return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  }
  function scoreObservations(rows, referenceTime, options={}) {
    const reference=typeof referenceTime==='number'?referenceTime:Date.parse(referenceTime);
    if (!Number.isFinite(reference)) throw new Error('A valid fixed reference time is required.');
    const distanceLimit=options.distanceKm??DISTANCE_KM, windowHours=options.windowHours??REPEAT_WINDOW_HOURS;
    return rows.map(row=>{
      const ageHours=(reference-Date.parse(row.observed))/3600000;
      const future=ageHours<0, stale=ageHours>STALE_AFTER_HOURS;
      const recency=future||stale?0:30*(1-ageHours/STALE_AFTER_HOURS);
      const confidence=25*row.confidence/100, frp=25*Math.min(row.frp/50,1);
      const contributors=rows.filter(other=>other!==row&&Math.abs(Date.parse(other.observed)-Date.parse(row.observed))<=windowHours*3600000&&distanceKm(row,other)<=distanceLimit);
      const repeat=Math.min(contributors.length,3)/3*20;
      const contributions={recency:Number(recency.toFixed(1)),confidence:Number(confidence.toFixed(1)),frp:Number(frp.toFixed(1)),nearby:Number(repeat.toFixed(1))};
      const score=Math.round(Object.values(contributions).reduce((sum,value)=>sum+value,0));
      return {...row, repeats:contributors.length, repeatIds:contributors.map(x=>x.id), contributions, score, priority:score>=70?'High':score>=45?'Medium':'Low', timeStatus:future?'Future timestamp':stale?'Stale (>24h)':'Within 24h'};
    }).sort((a,b)=>b.score-a.score);
  }

  function filterObservations(rows, filters={}) {
    const query=(filters.query||'').trim().toLowerCase(), priority=filters.priority||'all', confidence=filters.confidence||'all';
    return rows.filter(row=>(!query||`${row.place} ${row.satellite} ${row.id}`.toLowerCase().includes(query))&&(priority==='all'||row.priority===priority)&&(confidence==='all'||(confidence==='high'?row.confidence>=80:confidence==='low'?row.confidence<50:row.confidence>=50&&row.confidence<80)));
  }
  function exportCSV(rows) {
    const headers=['id','place','latitude','longitude','observed_utc','satellite','confidence_normalized','confidence_reported','brightness','frp_mw','repeat_count','repeat_observation_ids','recency_points','confidence_points','frp_points','nearby_points','priority_score','priority','time_status'];
    const quote=v=>{const s=v===null||v===undefined?'':String(v);return /[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
    return [headers.join(','),...rows.map(r=>[r.id,r.place,r.latitude,r.longitude,r.observed,r.satellite,r.confidence,r.confidenceReported??r.confidence,r.brightness,r.frp,r.repeats,(r.repeatIds||[]).join(';'),r.contributions?.recency,r.contributions?.confidence,r.contributions?.frp,r.contributions?.nearby,r.score,r.priority,r.timeStatus].map(quote).join(','))].join('\r\n');
  }
  return { parseCSV, scoreObservations, filterObservations, exportCSV, distanceKm, constants:{DISTANCE_KM,REPEAT_WINDOW_HOURS,STALE_AFTER_HOURS} };
});
