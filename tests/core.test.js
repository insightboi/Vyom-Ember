const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, scoreObservations, filterObservations, exportCSV, distanceKm, constants } = require('../core.js');

const header='id,place,latitude,longitude,observed_utc,satellite,confidence,frp';
const csv=(rows,head=header)=>`${head}\n${rows.join('\n')}`;
const row=(id='a',lat='40',lon='-120',time='2026-10-16T12:00:00Z',conf='100',frp='50',place='Redding, California')=>`${id},"${place}",${lat},${lon},${time},VIIRS,${conf},${frp}`;
const ref=Date.parse('2026-10-16T12:00:00Z');

test('parses a valid quoted record and common NASA-style headers',()=>{
  const parsed=parseCSV(csv(['40,-120,20261016,1230,h,50,"Redding, California"'], 'latitude,longitude,acq_date,acq_time,confidence,frp,location'));
  assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].place,'Redding, California');assert.equal(parsed.rows[0].confidence,90);
});

test('validates required headers before rows are processed',()=>{
  const result=parseCSV(csv([row()], 'latitude,longitude,observed_utc,frp'));
  assert.equal(result.rows.length,0);assert.ok(result.headerErrors.some(x=>x.includes('confidence')));
});

test('reports blank numeric cells and preserves valid neighboring rows',()=>{
  const result=parseCSV(csv([row('ok'),row('blank-lat','', '-120'),row('blank-confidence','40','-120','2026-10-16T12:00:00Z',''),row('blank-frp','40','-120','2026-10-16T12:00:00Z','60',''),row('also-ok','41','-121') ]));
  assert.equal(result.rows.length,2);assert.equal(result.errors.length,3);assert.ok(result.errors[0].reasons.includes('Latitude is blank.'));assert.equal(result.errors[0].rowNumber,3);assert.ok(result.errors[1].reasons.includes('Confidence is blank.'));assert.ok(result.errors[2].reasons.includes('FRP is blank.'));
});

test('rejects invalid coordinates and accepts exact coordinate boundaries',()=>{
  const result=parseCSV(csv([row('bad-lat','90.01','-120'),row('bad-lon','40','180.01'),row('north','90','180'),row('south','-90','-180')]));
  assert.equal(result.rows.length,2);assert.equal(result.errors.length,2);assert.ok(result.errors[0].reasons.some(x=>x.includes('Latitude')));assert.ok(result.errors[1].reasons.some(x=>x.includes('Longitude')));
});

test('rejects malformed calendar dates and timestamps without timezone',()=>{
  const result=parseCSV(csv([row('bad','40','-120','2026-02-30T12:00:00Z'),row('no-zone','40','-120','2026-10-16T12:00:00')]));
  assert.equal(result.rows.length,0);assert.equal(result.errors.length,2);assert.ok(result.errors.every(e=>e.reasons.some(x=>x.startsWith('Timestamp'))));
});

test('accepts FIRMS acquisition date/time and rejects missing acq_time header',()=>{
  const head='latitude,longitude,acq_date,acq_time,confidence,frp';
  const ok=parseCSV(csv(['40,-120,20261016,1230,n,0'],head));
  assert.equal(ok.rows[0].observed,'2026-10-16T12:30:00.000Z');assert.equal(ok.rows[0].confidence,65);
  const bad=parseCSV(csv(['40,-120,20261016,90,0'],'latitude,longitude,acq_date,confidence,frp'));
  assert.ok(bad.headerErrors.some(x=>x.includes('acq_time')));
});

test('uses acq_time with an ISO-formatted FIRMS acq_date instead of defaulting to noon',()=>{
  const result=parseCSV(csv(['39.118,-121.632,2026-10-16,0412,h,18.7'], 'latitude,longitude,acq_date,acq_time,confidence,frp'));
  assert.equal(result.errors.length,0);
  assert.equal(result.rows[0].observed,'2026-10-16T04:12:00.000Z');
  const invalid=parseCSV(csv(['39.118,-121.632,2026-10-16,2460,h,18.7'], 'latitude,longitude,acq_date,acq_time,confidence,frp'));
  assert.equal(invalid.rows.length,0);
});

test('future and stale observations receive zero recency points',()=>{
  const rows=parseCSV(csv([row('future','40','-120','2026-10-16T13:00:00Z'),row('stale','41','-121','2026-10-15T11:59:59Z')])).rows;
  const scored=scoreObservations(rows,ref);const future=scored.find(x=>x.id==='future'),stale=scored.find(x=>x.id==='stale');
  assert.equal(future.contributions.recency,0);assert.equal(future.timeStatus,'Future timestamp');assert.equal(stale.contributions.recency,0);assert.equal(stale.timeStatus,'Stale (>24h)');
});

test('score contributions use a fixed reference time, caps, and documented thresholds',()=>{
  const rows=parseCSV(csv([row('one'),row('two','40','-120','2026-10-15T12:00:00Z')])).rows;
  const [first]=scoreObservations(rows,ref);
  assert.deepEqual(first.contributions,{recency:30,confidence:25,frp:25,nearby:6.7});
  assert.equal(first.score,87);assert.equal(first.priority,'High');assert.deepEqual(first.repeatIds,['two']);
  assert.equal(constants.DISTANCE_KM,5);assert.equal(constants.REPEAT_WINDOW_HOURS,24);
  assert.equal(scoreObservations(rows,ref)[0].score,first.score);
});

test('nearby repeats include the 5 km and 24 hour boundaries, but exclude points beyond them',()=>{
  const atFiveKm=(5/6371)*180/Math.PI;
  const a={id:'a',latitude:0,longitude:0,observed:'2026-10-16T12:00:00Z',confidence:50,frp:10};
  const atBoundary={...a,id:'boundary',longitude:atFiveKm,observed:'2026-10-15T12:00:00Z'};
  const outside={...a,id:'outside',longitude:atFiveKm+0.001,observed:'2026-10-15T12:00:00Z'};
  assert.ok(Math.abs(distanceKm(a,atBoundary)-5)<1e-9);
  const scored=scoreObservations([a,atBoundary,outside],ref),first=scored.find(x=>x.id==='a');
  assert.deepEqual(first.repeatIds,['boundary']);
});

test('FRP, confidence, and recency boundaries are capped or zero at their limits',()=>{
  const rows=parseCSV(csv([row('edge','40','-120','2026-10-15T12:00:00Z','0','500')])).rows;
  const [scored]=scoreObservations(rows,ref);
  assert.equal(scored.contributions.recency,0);assert.equal(scored.contributions.confidence,0);assert.equal(scored.contributions.frp,25);
});

test('filters apply to scored records, and export serializes only the selected dataset',()=>{
  const rows=parseCSV(csv([row('a'),row('b','41','-121','2026-10-16T11:00:00Z','30','5','Ashland, Oregon')])).rows;
  const scored=scoreObservations(rows,ref),selected=filterObservations(scored,{query:'Ashland',priority:'all',confidence:'low'});
  assert.deepEqual(selected.map(x=>x.id),['b']);
  const exported=exportCSV(selected);assert.match(exported,/^id,place,latitude/);assert.match(exported,/^b,"Ashland, Oregon"/m);assert.doesNotMatch(exported,/^a,/m);
});

test('the bundled synthetic CSV has 24 valid data rows',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const parsed=parseCSV(fs.readFileSync(path.join(__dirname,'..','sample-observations.csv'),'utf8'));
  assert.equal(parsed.headerErrors.length,0);assert.equal(parsed.errors.length,0);assert.equal(parsed.rows.length,24);
});
