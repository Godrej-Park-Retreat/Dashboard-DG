const state = { data: null, selectedMonth: null, charts: {} };

const fmt = (n, digits=0) => Number.isFinite(Number(n))
  ? Number(n).toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits && Number(n)%1 ? 0 : 0 })
  : "—";
const pct = n => Number.isFinite(Number(n)) ? `${Number(n).toFixed(0)}%` : "—";
const validReading = r => r && (Number.isFinite(Number(r.fuelPercent)) || Number.isFinite(Number(r.runningHours)));

function levelState(percent, warning=30, critical=20) {
  if (!Number.isFinite(Number(percent))) return "normal";
  if (percent < critical) return "critical";
  if (percent <= warning) return "warning";
  return "normal";
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#039;"}[c]));}
function formatIST(value){
  if(!value) return "—";
  const d=new Date(value);
  if(Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true}).format(d)+" IST";
}
function formatDate(value){
  if(!value) return "—";
  const d=new Date(value+"T00:00:00");
  return new Intl.DateTimeFormat("en-IN",{day:"2-digit",month:"2-digit",year:"numeric"}).format(d);
}
function destroyChart(key){ if(state.charts[key]){state.charts[key].dispose();delete state.charts[key];} }

async function loadData(){
  const res=await fetch("./data/dashboard.json?ts="+Date.now());
  if(!res.ok) throw new Error("dashboard.json is not available yet");
  return await res.json();
}

function validReadings(data){ return (data.readings||[]).filter(validReading); }
function readingsForMonth(data,month){ return validReadings(data).filter(r=>String(r.date).slice(0,7)===month); }
function latestByDG(readings){
  const map={};
  readings.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(r=>{ if(validReading(r)) map[r.dg]=r; });
  return map;
}
function latestAvailableDate(data){
  const dates=validReadings(data).map(r=>r.date).sort();
  return dates.at(-1)||null;
}

function renderHeader(data, months){
  document.querySelector("#syncTime").textContent=`Data synced: ${formatIST(data.generatedAt)}`;
  document.querySelector("#dataTill").textContent=`Data available till: ${formatDate(latestAvailableDate(data))}`;
  const select=document.querySelector("#monthSelect");
  select.innerHTML="";
  months.forEach(m=>{
    const o=document.createElement("option");
    o.value=m;
    o.textContent=new Date(m+"-01T00:00:00").toLocaleDateString("en-IN",{month:"long",year:"numeric"});
    select.appendChild(o);
  });
  if(!state.selectedMonth || !months.includes(state.selectedMonth)) state.selectedMonth=months.at(-1);
  select.value=state.selectedMonth;
}

function renderFuelLevel(data, readings){
  const el=document.querySelector("#fuelLevelChart");
  if(!el)return;

  const cfg=(data.config?.dgs||[]);
  const latest=latestByDG(readings);
  const maxCapacity=Math.max(1000,...cfg.map(d=>Number(d.capacityLiters)||0));

  // Geometry deliberately follows Design.png: common baseline, capacity-proportional
  // tank heights, narrow tanks, a continuous outer tank and a clipped blue fill.
  const W=1200, H=350;
  const plotLeft=58, plotRight=1170, plotTop=18, plotBottom=294;
  const plotH=plotBottom-plotTop;
  const slotW=(plotRight-plotLeft)/cfg.length;
  const tankW=104;
  const y=v=>plotBottom-(v/maxCapacity)*plotH;
  // Global defaults for DG warning/critical thresholds. Per-DG values (if present)
  // will override these defaults.
  const defaultDgWarning = Number(data.config?.dgsWarningPercent ?? data.config?.warningPercent ?? 30);
  const defaultDgCritical = Number(data.config?.dgsCriticalPercent ?? data.config?.criticalPercent ?? 20);

  const statusColor=d=>{
    const p=Number(latest[d.id]?.fuelPercent);
    const warn = Number.isFinite(Number(d.warningPercent)) ? Number(d.warningPercent) : defaultDgWarning;
    const crit = Number.isFinite(Number(d.criticalPercent)) ? Number(d.criticalPercent) : defaultDgCritical;
    const st=levelState(p, warn, crit);
    return st==="critical"?"#ef3340":st==="warning"?"#f5a400":"#2d78e8";
  };

  const esc=s=>escapeHtml(s);
  let svg=`<svg class="fuel-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Current fuel level by DG">
    <defs>`;
  cfg.forEach(d=>{
    const cap=Number(d.capacityLiters)||1000;
    const x=plotLeft+slotW*(cfg.indexOf(d)+.5)-tankW/2;
    const top=y(cap);
    svg+=`<clipPath id="tankClip-${esc(d.id)}"><rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${tankW}" height="${(plotBottom-top).toFixed(1)}" rx="14"/></clipPath>`;
  });
  svg+=`</defs>`;

  // Grid + Y axis exactly on 100 L increments.
  for(let v=0;v<=maxCapacity;v+=100){
    const yy=y(v);
    svg+=`<line class="fuel-grid" x1="${plotLeft}" y1="${yy.toFixed(1)}" x2="${plotRight}" y2="${yy.toFixed(1)}"/>`;
    svg+=`<text class="fuel-axis" x="${plotLeft-10}" y="${(yy+4).toFixed(1)}" text-anchor="end">${v} L</text>`;
  }

  cfg.forEach((d,i)=>{
    const cap=Number(d.capacityLiters)||1000;
    const r=latest[d.id]||{};
    const actual=Math.max(0,Math.min(cap,Number(r.fuelActual)||0));
    const percent=Number.isFinite(Number(r.fuelPercent))?Number(r.fuelPercent):(cap?actual/cap*100:0);
    const x=plotLeft+slotW*(i+.5)-tankW/2;
    const top=y(cap);
    const fillTop=y(actual);
    const fillH=Math.max(0,plotBottom-fillTop);
    const color=statusColor(d);

    // Complete tank body first. This outline remains continuous around the fill.
    svg+=`<rect class="fuel-tank" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${tankW}" height="${(plotBottom-top).toFixed(1)}" rx="14"/>`;
    // Fuel is clipped to the tank shape, giving the same rounded top/bottom silhouette.
    if(fillH>0){
      svg+=`<g clip-path="url(#tankClip-${esc(d.id)})"><rect class="fuel-fill" x="${x}" y="${fillTop}" width="${tankW}" height="${fillH}" style="fill:${color}"/></g>`;
      // Redraw a very subtle top border around the fill for crispness.
      svg+=`<path d="M ${x+14} ${fillTop} H ${x+tankW-14} Q ${x+tankW} ${fillTop} ${x+tankW} ${fillTop+14}" fill="none" stroke="${color}" stroke-width="1" opacity=".35"/>`;
    }
    // Outer border is drawn last, so it never disappears behind the blue fill.
    svg+=`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${tankW}" height="${(plotBottom-top).toFixed(1)}" rx="14" fill="none" stroke="#b8c6db" stroke-width="1.2"/>`;
    svg+=`<text class="fuel-capacity" x="${x+tankW/2}" y="${Math.max(15,top-7)}" text-anchor="middle">${fmt(cap)} L</text>`;
    if(actual>0){
      const centerY=fillTop+fillH/2;
      svg+=`<text class="fuel-value" x="${x+tankW/2}" y="${centerY-1}" text-anchor="middle">${percent.toFixed(0)}%</text>`;
      svg+=`<text class="fuel-value" x="${x+tankW/2}" y="${centerY+20}" text-anchor="middle" font-size="14">${fmt(actual)} L</text>`;
    }
    svg+=`<text class="fuel-dg" x="${x+tankW/2}" y="${plotBottom+31}" text-anchor="middle">${esc(d.id)}</text>`;
  });
  svg+=`</svg>`;
  el.innerHTML=svg;
}

function renderExternalTanks(data){
  const tanks=data.config?.externalTanks||[];
  const el=document.querySelector("#externalTanks");
  if(!el)return;

  const W=450, H=300;
  const axisX=50, plotLeft=60, plotRight=460;
  const top=20, bottom=240, maxScale=1000, tankW=82;
  const plotH=bottom-top;
  const tankXs=tanks.length===1 ? [175-tankW/2] : [115, 305];

  const y=v=>bottom-(v/maxScale)*plotH;
  const esc=s=>escapeHtml(s);

  let svg=`<svg class="external-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
      role="img" aria-label="External fuel tanks"><defs>`;

  tanks.forEach((t,i)=>{
    const cap=Math.min(Number(t.capacityLiters)||1000,maxScale);
    const x=tankXs[i];
    const topY=y(cap);
    svg+=`<clipPath id="extClip-${esc(t.id)}">
      <rect x="${x}" y="${topY}" width="${tankW}" height="${bottom-topY}" rx="13"/>
    </clipPath>`;
  });

  svg+=`</defs>`;

  // Shared 0-1000 L scale and dotted grid across both tanks.
  for(let v=0;v<=maxScale;v+=100){
    const yy=y(v);
    svg+=`<line class="external-grid-line" x1="${plotLeft}" y1="${yy}" x2="${plotRight}" y2="${yy}"/>`;
    svg+=`<text class="external-axis-label" x="${axisX}" y="${yy+4}" text-anchor="end">${v} L</text>`;
  }

  tanks.forEach((t,i)=>{
    const cap=Math.min(Number(t.capacityLiters)||1000,maxScale);
    const litres=Math.max(0,Math.min(cap,Number(t.currentLiters)||0));
    const percent=cap>0?litres/cap*100:0;
    const pctText=percent.toFixed(1).replace(/\.0$/,"");
    const x=tankXs[i];
    const topY=y(cap);
    const fillTop=y(litres);
    const fillH=Math.max(0,bottom-fillTop);

    svg+=`<rect class="external-tank-body" x="${x}" y="${topY}" width="${tankW}" height="${bottom-topY}" rx="13"/>`;

    if(fillH>0){
      svg+=`<g clip-path="url(#extClip-${esc(t.id)})">
        <rect class="external-tank-fill" x="${x}" y="${fillTop}" width="${tankW}" height="${fillH}"/>
      </g>`;
    }

    svg+=`<rect class="external-tank-border" x="${x}" y="${topY}" width="${tankW}" height="${bottom-topY}" rx="13"/>`;
    svg+=`<text class="external-capacity-label" x="${x+tankW/2}" y="${topY-8}" text-anchor="middle">${fmt(cap)} L</text>`;

    if(litres>0){
      const centerY=fillTop+fillH/2;
      svg+=`<text class="external-value-label" x="${x+tankW/2}" y="${centerY-2}" text-anchor="middle">${pctText}%</text>`;
      svg+=`<text class="external-value-label" x="${x+tankW/2}" y="${centerY+19}" text-anchor="middle">${fmt(litres)} L</text>`;
    }

    // Details BELOW each tank.
    const center=x+tankW/2;
    svg+=`<text class="external-yard-label" x="${center}" y="281" text-anchor="middle">${esc(t.yard||t.name)}</text>`;
    svg+=`<text class="external-detail-svg" x="${center}" y="304" text-anchor="middle">Capacity: ${fmt(cap)} L</text>`;
    svg+=`<text class="external-detail-svg" x="${center}" y="327" text-anchor="middle">Level: <tspan class="external-detail-strong">${fmt(litres)} L (${pctText}%)</tspan></text>`;
  });

  svg+=`</svg>`;
  el.innerHTML=svg;
}function renderOverview(data, readings){
  const cfg=data.config?.dgs||[]; const latest=latestByDG(readings);
  let normal=0,warning=0,critical=0;
  // Use global defaults for counting overview states; per-DG values override.
  const defaultDgWarning2 = Number(data.config?.dgsWarningPercent ?? data.config?.warningPercent ?? 30);
  const defaultDgCritical2 = Number(data.config?.dgsCriticalPercent ?? data.config?.criticalPercent ?? 20);
  cfg.forEach(d=>{
    const p = Number(latest[d.id]?.fuelPercent);
    const warn = Number.isFinite(Number(d.warningPercent)) ? Number(d.warningPercent) : defaultDgWarning2;
    const crit = Number.isFinite(Number(d.criticalPercent)) ? Number(d.criticalPercent) : defaultDgCritical2;
    const st=levelState(p, warn, crit);
    if(st==="normal") normal++;
    else if(st==="warning") warning++;
    else critical++;
  });
  document.querySelector("#overviewCards").innerHTML=`
    <div class="overview-card"><div class="summary-icon blue">⛽</div><div><div class="overview-number">${cfg.length}</div><div class="overview-label">DG Sets</div><div class="overview-label">2 Yards</div></div></div>
    <div class="overview-card"><div class="summary-icon green">▰</div><div><div class="overview-number">${normal}</div><div class="overview-label">DGs &gt; 30%</div><div class="overview-state normal">Normal</div></div></div>
    <div class="overview-card"><div class="summary-icon yellow">!</div><div><div class="overview-number">${warning}</div><div class="overview-label">DGs 20% - 30%</div><div class="overview-state warning">Warning</div></div></div>
    <div class="overview-card"><div class="summary-icon red">!</div><div><div class="overview-number">${critical}</div><div class="overview-label">DGs &lt; 20%</div><div class="overview-state critical">Critical</div></div></div>`;
}

function deltaHours(a,b){
  if(!Number.isFinite(Number(a?.runningHours))||!Number.isFinite(Number(b?.runningHours))) return 0;
  return Math.max(0,Number(b.runningHours)-Number(a.runningHours));
}
function monthRunningTotals(data, readings){
  const cfg=data.config?.dgs||[]; const byDG={};
  cfg.forEach(d=>{
    const rs=readings.filter(r=>r.dg===d.id && Number.isFinite(Number(r.runningHours))).sort((a,b)=>a.date.localeCompare(b.date));
    byDG[d.id]=rs.length>1?Math.max(0,Number(rs.at(-1).runningHours)-Number(rs[0].runningHours)):0;
  });
  const yard1=cfg.filter(d=>d.yard==="Yard 1").reduce((s,d)=>s+byDG[d.id],0);
  const yard2=cfg.filter(d=>d.yard==="Yard 2").reduce((s,d)=>s+byDG[d.id],0);
  return {yard1,yard2,total:yard1+yard2};
}
function renderRunningSummary(data,readings){
  const x=monthRunningTotals(data,readings);
  document.querySelector("#runningSummary").innerHTML=`
    <div class="summary-row yard1"><div><div class="yard-name">Yard 1</div><small>DG1, DG2, DG3</small></div><div class="summary-value"><span>Total Hours</span><strong>${fmt(x.yard1,2)} h</strong></div></div>
    <div class="summary-row yard2"><div><div class="yard-name">Yard 2</div><small>DG4, DG5, DG6</small></div><div class="summary-value"><span>Total Hours</span><strong>${fmt(x.yard2,2)} h</strong></div></div>
    <div class="overall-row"><strong>Overall Total</strong><span class="overall-value">${fmt(x.total,2)} h</span></div>`;
}

function dailyConsumption(readings,date,allowedDGs){
  const previousDate=[...new Set(readings.map(r=>r.date))].filter(d=>d<date).sort().at(-1);
  if(!previousDate) return {fuel:0,hours:0,lph:null};
  let fuel=0,hours=0;
  for(const dg of allowedDGs){
    const a=readings.find(r=>r.dg===dg&&r.date===previousDate);
    const b=readings.find(r=>r.dg===dg&&r.date===date);
    if(!a||!b) continue;
    const h=deltaHours(a,b);
    const added=Number(b.fuelAdded)||0;
    const consumed=Number(a.fuelActual)+added-Number(b.fuelActual);
    if(h>0 && Number.isFinite(consumed) && consumed>=0){fuel+=consumed;hours+=h;}
  }
  return {fuel,hours,lph:hours?fuel/hours:null};
}
function renderConsumptionSummary(data,readings){
  const date=[...new Set(readings.map(r=>r.date))].sort().at(-1);
  const yard1=(data.config?.dgs||[]).filter(d=>d.yard==="Yard 1").map(d=>d.id);
  const yard2=(data.config?.dgs||[]).filter(d=>d.yard==="Yard 2").map(d=>d.id);
  const c1=dailyConsumption(readings,date,yard1), c2=dailyConsumption(readings,date,yard2);
  const text=c=>c.lph==null?"—":`${fmt(c.fuel)} L`;
  const label=c=>c.lph==null?"No running-hour delta":"Total Consumed";
  document.querySelector("#consumptionSummary").innerHTML=`
    <div class="summary-row yard1"><div><div class="yard-name">Yard 1</div><small>DG1, DG2, DG3</small></div><div class="summary-value"><span>${label(c1)}</span><strong>${text(c1)}</strong></div></div>
    <div class="summary-row yard2"><div><div class="yard-name">Yard 2</div><small>DG4, DG5, DG6</small></div><div class="summary-value"><span>${label(c2)}</span><strong>${text(c2)}</strong></div></div>
    <div class="overall-row"><strong>Latest day</strong><span class="overall-value">${formatDate(date)}</span></div>`;
}

function renderComparison(readings){
  const dates=[...new Set(readings.map(r=>r.date))].sort(); const current=dates.at(-1), previous=dates.at(-2);
  document.querySelector("#comparisonDates").textContent=previous&&current?`${formatDate(previous)} → ${formatDate(current)}`:"Only one reading is available.";
  const ids=["DG1","DG2","DG3","DG4","DG5","DG6"];
  const by=(date,id)=>readings.find(r=>r.date===date&&r.dg===id);
  document.querySelector("#comparison").innerHTML=ids.map(id=>{
    const a=by(previous,id),b=by(current,id),av=Number(a?.fuelPercent),bv=Number(b?.fuelPercent),d=bv-av,cls=d>0?"up":d<0?"down":"flat";
    return `<article class="compare-card"><strong>${id}</strong><div class="compare-row"><div><small>${formatDate(previous)}</small><div class="compare-value">${pct(av)}</div></div><div><small>${formatDate(current)}</small><div class="compare-value">${pct(bv)}</div></div></div><div class="delta ${cls}">${Number.isFinite(d)?`${d>0?"+":""}${d.toFixed(1)} percentage points`:"—"}</div></article>`;
  }).join("");
}

function renderFuelAdditions(readings){
  destroyChart("additions");
  const chart=echarts.init(document.querySelector("#fuelAdditionsChart")); state.charts.additions=chart;
  const dates=[...new Set(readings.map(r=>r.date))].sort(); const ids=["DG1","DG2","DG3","DG4","DG5","DG6"];
  const series=ids.map(id=>({name:id,type:"bar",stack:"total",data:dates.map(date=>Number(readings.find(r=>r.date===date&&r.dg===id)?.fuelAdded)||0)}));
  chart.setOption({tooltip:{trigger:"axis"},legend:{top:5},grid:{left:55,right:25,top:45,bottom:70},xAxis:{type:"category",data:dates.map(formatDate),axisLabel:{rotate:45}},yAxis:{type:"value",name:"Litres"},series});
}

function renderTrend(data,readings,month){
  destroyChart("trend");
  const chart=echarts.init(document.querySelector("#dailyTrendChart")); state.charts.trend=chart;
  const days=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate();
  const x=Array.from({length:days},(_,i)=>`${month}-${String(i+1).padStart(2,"0")}`);
  const ids=["DG1","DG2","DG3","DG4","DG5","DG6"];
  const series=ids.map(id=>({name:id,type:"line",smooth:true,data:x.map(d=>{const r=readings.find(z=>z.date===d&&z.dg===id);return r&&Number.isFinite(Number(r.fuelPercent))?Number(r.fuelPercent):null}),connectNulls:false}));
  chart.setOption({tooltip:{trigger:"axis"},legend:{top:5},grid:{left:55,right:25,top:45,bottom:55},xAxis:{type:"category",data:x.map(d=>d.slice(8)),name:"Day"},yAxis:{type:"value",min:0,max:100,name:"Fuel %"},series});
}

function render(){
  const readings=readingsForMonth(state.data,state.selectedMonth);
  const has=readings.length>0;
  document.querySelector("#dashboard").hidden=!has; document.querySelector("#emptyState").hidden=has;
  if(!has)return;
  renderFuelLevel(state.data,readings);
  renderExternalTanks(state.data);
  renderOverview(state.data,readings);
  renderRunningSummary(state.data,readings);
  renderConsumptionSummary(state.data,readings);
  renderComparison(readings);
  renderFuelAdditions(readings);
  renderTrend(state.data,readings,state.selectedMonth);
}

async function init(){
  try{
    state.data=await loadData();
    const months=[...new Set(validReadings(state.data).map(r=>String(r.date).slice(0,7)))].sort();
    if(!months.length){document.querySelector("#emptyState").hidden=false;return;}
    renderHeader(state.data,months); render();
  }catch(e){
    const status=document.querySelector("#status"); status.hidden=false; status.textContent=e.message; status.className="status error";
    document.querySelector("#emptyState").hidden=false;
  }
}

document.querySelector("#monthSelect").addEventListener("change",e=>{state.selectedMonth=e.target.value;render();});
document.querySelector("#refreshBtn").addEventListener("click",init);
window.addEventListener("resize",()=>Object.values(state.charts).forEach(c=>c.resize()));
init();
