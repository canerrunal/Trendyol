const state = { data: null, filter: 'all', countdown: 15, selected: null };
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[char]));
const fmtNumber = value => new Intl.NumberFormat('tr-TR').format(Number(value || 0));
const fmtTime = value => value ? new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '—';
const fmtDateTime = value => value ? new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '—';
const fmtDay = value => new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',weekday:'short',day:'2-digit'}).format(new Date(`${value}T12:00:00+03:00`));
const fmtDuration = seconds => seconds == null ? '—' : seconds >= 60 ? `${Math.floor(seconds/60)} dk ${seconds%60} sn` : `${seconds} sn`;
const healthText = health => ({healthy:'Başarılı',failed:'Hata',warning:'Uyarı',running:'Çalışıyor',paused:'Duraklatıldı'}[health] || health);
const platformMark = platform => ({instagram:'IG',facebook:'FB',linkedin:'IN',x:'X'}[platform] || platform.slice(0,2).toUpperCase());
const socialOutcome = outcome => ({success:'Başarılı',failed:'Hata',running:'Çalışıyor',cancelled:'İptal',unknown:'Veri yok'}[outcome] || outcome);
const prettySlug = slug => String(slug || '').replace(/-20\d{2}$/,'').split('-').filter(Boolean).map((word,index)=>index ? word : word.charAt(0).toUpperCase()+word.slice(1)).join(' ');

function relative(value) {
  if (!value) return '—';
  const diff = Math.round((new Date(value) - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const text = abs < 60 ? `${abs} sn` : abs < 3600 ? `${Math.round(abs/60)} dk` : abs < 86400 ? `${Math.round(abs/3600)} sa` : `${Math.round(abs/86400)} gün`;
  return diff >= 0 ? `${text} sonra` : `${text} önce`;
}

function renderNext() {
  const next = state.data.summary.next;
  $('#nextRun').classList.remove('skeleton');
  if (!next) return $('#nextRun').innerHTML = '<span class="next-label">SIRADAKİ GÖREV</span><p>Planlanmış görev yok.</p>';
  $('#nextRun').innerHTML = `<span class="next-label">SIRADAKİ GÖREV</span><div class="next-time"><div><strong>${escapeHtml(next.label)}</strong><span>${fmtDateTime(next.at)} · ${next.schedule}</span></div><b class="countdown">${relative(next.at)}</b></div>`;
}

function renderAlerts() {
  const failed = state.data.profiles.filter(item => item.health === 'failed');
  if (!failed.length) return $('#alertArea').innerHTML = '';
  $('#alertArea').innerHTML = failed.map(item => `<div class="alert"><span class="alert-icon">!</span><div><strong>${escapeHtml(item.label)} görevi başarısız</strong><p>${escapeHtml(item.error || 'Çalışma tamamlanamadı.')}${item.delivery === 'failed' ? ` · Telegram: ${escapeHtml(item.deliveryError)}` : ''} Son geçerli rapor korunuyor.</p></div><button data-open="${item.slug}">Ayrıntıyı gör →</button></div>`).join('');
}

function renderSummary() {
  const s = state.data.summary;
  const cards = [
    ['Toplam görev',s.total,'aktif kategori',''],
    ['Bugün başarılı',s.completedToday,`${s.total} görevin ${s.completedToday} tanesi`,'good'],
    ['Dikkat gereken',s.failed+s.warning,`${s.failed} hata · ${s.warning} uyarı`,s.failed?'bad':'warn'],
    ['İzlenen ürün',fmtNumber(s.totalProducts),'son geçerli havuz toplamı',''],
    ['GitHub',state.data.repository.shortHead,'main güncel commit','good']
  ];
  $('#summaryCards').innerHTML = cards.map(([label,value,detail,cls]) => `<article class="stat ${cls}"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong><span class="stat-detail">${detail}</span></article>`).join('');
}

function renderSocial() {
  const social = state.data.social;
  if (!social) return;
  const summary = social.summary || {};
  const lastOutcome = socialOutcome(summary.lastOutcome);
  const statusClass = !social.available ? 'unavailable' : social.enabled ? 'active' : 'paused';
  $('#socialAutomation').className = `social-automation ${statusClass}`;
  $('#socialAutomation').textContent = !social.available ? 'Bağlantı yok' : social.enabled ? 'Otomatik yayın açık' : 'Otomatik yayın kapalı';
  $('#socialWorkflow').href = social.workflowUrl;
  $('#socialRepository').href = social.repositoryUrl;
  $('#socialSummary').innerHTML = [
    ['Aktif platform',`${summary.activePlatforms || 0}/4`,social.enabled ? 'push sonrası otomatik' : 'yayın hattı kapalı'],
    ['Yayın kaydı',fmtNumber(summary.publicationCount),'platform etiketleri'],
    ['Son çalışma',lastOutcome,fmtDateTime(summary.lastRunAt),summary.lastOutcome === 'failed' ? 'bad' : summary.lastOutcome === 'running' ? 'running' : 'good'],
    ['Başarılı iş',summary.successfulRuns || 0,`${summary.failedRuns || 0} hata kaydı`,summary.failedRuns ? 'warn' : 'good']
  ].map(([label,value,detail,cls='']) => `<div class="social-stat ${cls}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`).join('');
  $('#socialPlatforms').innerHTML = (social.platforms || []).map(platform => {
    const latest = platform.latest;
    return `<article class="social-platform ${platform.enabled ? 'enabled' : 'disabled'}">
      <div class="platform-top"><span class="platform-mark ${platform.key}">${platformMark(platform.key)}</span><div><strong>${escapeHtml(platform.label)}</strong><small>${escapeHtml(platform.handle)}</small></div><b>${platform.enabled ? 'Açık' : 'Kapalı'}</b></div>
      <div class="platform-count"><strong>${fmtNumber(platform.publicationCount)}</strong><span>yayın kaydı</span></div>
      <p>${latest ? escapeHtml(prettySlug(latest.slug)) : 'Henüz yayın etiketi yok'}</p>
      <div class="platform-links"><a href="${escapeHtml(platform.profileUrl)}" target="_blank" rel="noreferrer">Profil ↗</a>${latest ? `<a href="${escapeHtml(latest.announcementUrl)}" target="_blank" rel="noreferrer">Duyuru ↗</a>` : ''}</div>
    </article>`;
  }).join('');
  const publications = social.recentPublications || [];
  $('#socialPublications').innerHTML = publications.length ? publications.map(item => `<a class="social-row" href="${escapeHtml(item.announcementUrl)}" target="_blank" rel="noreferrer"><span class="mini-mark">${platformMark(item.platform)}</span><div><strong>${escapeHtml(prettySlug(item.slug))}</strong><small>${escapeHtml(item.platform)} · ${fmtDateTime(item.sourceCommitAt)}</small></div><i>↗</i></a>`).join('') : '<p class="social-empty">Henüz sosyal yayın kaydı yok.</p>';
  const runs = social.recentRuns || [];
  $('#socialRuns').innerHTML = runs.length ? runs.map(run => `<a class="social-row run-${run.outcome}" href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer"><span class="run-dot"></span><div><strong>${socialOutcome(run.outcome)}</strong><small>${escapeHtml(run.event === 'workflow_dispatch' ? 'Manuel test' : 'Duyuru değişikliği')} · ${fmtDateTime(run.createdAt)}</small></div><i>#${run.id}</i></a>`).join('') : `<p class="social-empty">${escapeHtml(social.error || 'Henüz otomasyon çalışması yok.')}</p>`;
}

function taxonomyStageState(stage) {
  if (!stage.enabled) return 'paused';
  if (['running','claimed'].includes(stage.status)) return 'running';
  if (['failed','error'].includes(stage.status)) return 'failed';
  if (['completed','ok'].includes(stage.status)) return 'healthy';
  return 'waiting';
}

function renderTaxonomy() {
  const taxonomy = state.data.taxonomy;
  if (!taxonomy) return;
  const catalog = taxonomy.catalog; const latest = taxonomy.latest; const today = taxonomy.today;
  const runFresh = latest.date === state.data.today;
  const qualityGateHtml = latest.status === 'PASS'
    ? '<span style="color:var(--ok)">PASS · Yayında</span>'
    : latest.status === 'PARTIAL'
      ? '<span style="color:var(--bad)">PARTIAL · Yayın Engelli</span>'
      : escapeHtml(latest.status || 'Bekleniyor');
  const publishDetail = latest.status === 'PASS'
    ? 'Canlı yayın onaylandı'
    : latest.status === 'PARTIAL'
      ? '⛔ Production publish BLOCKED'
      : (latest.runId ? `Run: ${latest.runId.slice(0, 22)}` : 'Henüz çalışmadı');

  $('#taxonomyOverview').innerHTML = [
    ['Kalite & Yayın', qualityGateHtml, publishDetail],
    ['Kategori evreni', fmtNumber(catalog.total), `${fmtNumber(catalog.uniqueCategories)} benzersiz kimlik · ${catalog.duplicatePaths} tekrar`],
    ['Derinlik', catalog.maxDepth == null ? '—' : `${catalog.maxDepth + 1} seviye`, `${fmtNumber(catalog.leaves)} uç kategori`],
    ['Kapsama & Fresh', latest.totalCategories ? `%${latest.coverage}` : 'Bekleniyor', `Fresh: %${latest.freshCoverage || latest.coverage || 0}`],
    ['Benzersiz ürün', fmtNumber(latest.uniqueProducts), `${fmtNumber(latest.rankingMemberships)} sıra · ${fmtNumber(latest.emptyCategories)} boş`],
    ['Bugünkü ilerleme', `${fmtNumber(today.completedCategories)}/${fmtNumber(catalog.uniqueCategories)}`, today.failedCategories ? `${today.failedCategories} kategori hatalı` : (latest.runId || 'işçiler sırayla çalışır')]
  ].map(([label,value,detail]) => `<div class="taxonomy-stat"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`).join('');
  $('#taxonomyStages').innerHTML = taxonomy.stages.map(stage => {
    const stateName = taxonomyStageState(stage);
    return `<div class="taxonomy-stage ${stateName}"><i></i><span><strong>${escapeHtml(stage.label)}</strong><small>${stage.schedule} · ${stage.jobId || 'kurulmadı'}</small></span><b>${stateName === 'healthy' ? 'Hazır' : stateName === 'running' ? 'Çalışıyor' : stateName === 'failed' ? 'Hata' : stateName === 'paused' ? 'Eksik' : 'Bekliyor'}</b></div>`;
  }).join('');
  const topRoots = [...catalog.rootsBreakdown].sort((a,b)=>(b.productCount||0)-(a.productCount||0)).slice(0,10);
  const max = Math.max(1,...topRoots.map(root=>root.productCount||0));
  $('#taxonomyRoots').innerHTML = `<div class="taxonomy-roots-title"><span>En çok ürün bulunan ana kategoriler</span><small>Benzersiz ürün · hedef ≥ 1.000</small></div>` + topRoots.map(root => {
    const count = root.productCount || 0;
    const targetClass = count >= (root.minimumProducts || 1000) ? '' : ' below-target';
    const targetLabel = count >= (root.minimumProducts || 1000) ? 'hedef tamam' : 'hedef altı';
    return `<div class="root-row${targetClass}"><span>${escapeHtml(root.name)}</span><i><b style="width:${Math.max(2,count/max*100)}%"></b></i><strong>${fmtNumber(count)}</strong><small>${targetLabel}</small></div>`;
  }).join('');
  $('#taxonomyGithub').href = taxonomy.githubUrl;
}

function renderTimeline() {
  $('#timeline').innerHTML = state.data.profiles.map(item => `<button class="timeline-item ${item.health}" data-open="${item.slug}"><span class="timeline-time">${item.schedule}</span><span class="timeline-name">${escapeHtml(item.label)}</span><span class="timeline-state">${healthText(item.health)}</span></button>`).join('');
}

function renderJobs() {
  let items = state.data.profiles;
  if (state.filter === 'attention') items = items.filter(item => ['failed','warning','paused'].includes(item.health));
  if (state.filter === 'running') items = items.filter(item => item.health === 'running');
  if (!items.length) return $('#jobGrid').innerHTML = '<div class="panel" style="padding:30px;color:var(--muted)">Bu filtrede görev bulunmuyor.</div>';
  $('#jobGrid').innerHTML = items.map(item => {
    const coverage = item.quality.coverage || {};
    const deliveryClass = item.delivery === 'failed' ? 'failed' : '';
    const progress = item.progress ? `<div class="progress"><i style="width:${item.progress.percent}%"></i></div><span class="progress-label">${item.progress.phase === 'detail' ? 'Detay' : 'Liste'} ${item.progress.current}/${item.progress.total}</span>` : '';
    return `<article class="job-card ${item.health}" data-open="${item.slug}">
      <div class="job-top"><div class="job-title"><span class="job-icon">${escapeHtml(item.label.slice(0,2).toUpperCase())}</span><div><strong>${escapeHtml(item.label)}</strong><span>${item.schedule} · ${item.jobId || 'görev yok'}</span></div></div><span class="status-badge">${healthText(item.health)}</span></div>
      ${item.error ? `<p class="job-error">${escapeHtml(item.error)}</p>` : ''}${progress}
      <div class="job-metrics"><div class="metric"><span>Ürün</span><strong>${item.quality.productCount || '—'}</strong></div><div class="metric"><span>Detay</span><strong>%${item.quality.detailSuccessRate || 0}</strong></div><div class="metric"><span>Stok</span><strong>%${coverage.stock_status ?? 0}</strong></div></div>
      <div class="job-footer"><span>Son: ${fmtDateTime(item.lastRunAt)}</span><span class="delivery ${deliveryClass}"><i></i>${item.delivery === 'delivered' ? 'Telegram iletildi' : item.delivery === 'failed' ? 'Teslim hatası' : 'Teslim bekleniyor'}</span></div>
    </article>`;
  }).join('');
}

function renderHistory() {
  const dates = state.data.profiles[0]?.history.map(item => item.date) || [];
  const header = `<div class="history-row header"><span>Kategori</span>${dates.map(date => `<span>${fmtDay(date)}</span>`).join('')}</div>`;
  const rows = state.data.profiles.map(item => `<div class="history-row"><span class="history-name">${escapeHtml(item.label)}</span>${item.history.map(day => `<span class="history-cell" title="${day.date} · ${day.status} · ${fmtDuration(day.durationSeconds)}"><i class="history-dot ${day.status}"></i></span>`).join('')}</div>`).join('');
  $('#historyMatrix').innerHTML = header + rows;
}

function renderEvents() {
  $('#eventList').innerHTML = state.data.recentEvents.map(item => `<div class="event ${item.status}"><i class="event-dot"></i><div><strong>${escapeHtml(item.label)}</strong><p>${item.status === 'completed' ? `Başarıyla tamamlandı · ${fmtDuration(item.durationSeconds)}` : item.status === 'failed' ? escapeHtml(item.error || 'Başarısız') : 'Çalışma devam ediyor'}</p></div><time>${fmtDateTime(item.startedAt)}</time></div>`).join('');
}

function openDrawer(slug) {
  const item = state.data.profiles.find(profile => profile.slug === slug);
  if (!item) return;
  state.selected = slug;
  const coverage = item.quality.coverage || {};
  const coverageRows = Object.entries(coverage).map(([key,value]) => `<div class="coverage-row"><span>${escapeHtml(key.replaceAll('_',' '))}</span><span class="coverage-bar"><i style="width:${value}%"></i></span><strong>%${value}</strong></div>`).join('');
  $('#drawerContent').innerHTML = `<p class="eyebrow">${escapeHtml(item.schedule)} GÜNLÜK GÖREV</p><h2>${escapeHtml(item.label)}</h2><p class="drawer-sub">${escapeHtml(item.sourceLabel)} · ${item.jobId}</p>
    <div class="drawer-actions"><a href="${item.reportUrl}" target="_blank">Yerel rapor ↗</a><a href="${item.githubUrl}" target="_blank" rel="noreferrer">GitHub raporu ↗</a><a href="${item.logUrl}" target="_blank">Tam log ↗</a></div>
    ${item.error ? `<div class="alert"><span class="alert-icon">!</span><div><strong>Son hata</strong><p>${escapeHtml(item.error)}</p></div></div>` : ''}
    <div class="drawer-section"><h3>Çalışma bilgisi</h3><div class="job-metrics"><div class="metric"><span>Son çalışma</span><strong>${fmtTime(item.lastRunAt)}</strong></div><div class="metric"><span>Sonraki</span><strong>${fmtTime(item.nextRunAt)}</strong></div><div class="metric"><span>Commit</span><strong>${item.commit?.shortHash || '—'}</strong></div></div></div>
    <div class="drawer-section"><h3>Veri kapsamı</h3>${coverageRows}</div>
    <div class="drawer-section"><h3>Son teknik log</h3><pre>${escapeHtml(item.latestLog.tail || 'Henüz log yok.')}</pre></div>`;
  $('#drawerBackdrop').hidden = false;
  $('#detailDrawer').classList.add('open');
  $('#detailDrawer').setAttribute('aria-hidden','false');
}

function closeDrawer() { $('#detailDrawer').classList.remove('open'); $('#detailDrawer').setAttribute('aria-hidden','true'); setTimeout(() => $('#drawerBackdrop').hidden = true, 220); state.selected = null; }

function renderAll() {
  renderNext(); renderAlerts(); renderSummary(); renderSocial(); renderTaxonomy(); renderTimeline(); renderJobs(); renderHistory(); renderEvents();
  $('#githubLink').href = state.data.repository.github;
  $('#lastUpdated').textContent = `Son kontrol ${fmtDateTime(state.data.generatedAt)} · 15 sn otomatik yenileme`;
  if (state.selected) openDrawer(state.selected);
}

async function loadStatus(fresh = false) {
  $('#refreshButton').disabled = true;
  try {
    const response = await fetch(`/api/status${fresh ? '?fresh=1' : ''}`, { cache:'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json(); state.countdown = 15; renderAll();
    if (fresh) showToast('Durum yenilendi');
  } catch (error) { showToast(`Bağlantı hatası: ${error.message}`, true); }
  finally { $('#refreshButton').disabled = false; }
}

function showToast(text, bad = false) { const toast=$('#toast');toast.textContent=text;toast.style.background=bad?'#ffd7d9':'#dffbea';toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2600); }
function updateClock(){ $('#clock').textContent=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date()); }

document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]'); if (open) openDrawer(open.dataset.open);
  const filter = event.target.closest('[data-filter]'); if (filter) { state.filter=filter.dataset.filter; document.querySelectorAll('.filter').forEach(button=>button.classList.toggle('active',button===filter)); renderJobs(); }
});
$('#refreshButton').addEventListener('click',()=>loadStatus(true)); $('#drawerClose').addEventListener('click',closeDrawer); $('#drawerBackdrop').addEventListener('click',closeDrawer); document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDrawer()});
setInterval(()=>{updateClock();state.countdown--;if(state.countdown<=0)loadStatus();$('#refreshCountdown').textContent=`${Math.max(0,state.countdown)} sn sonra yenilenecek`;if(state.data)renderNext()},1000);
updateClock(); loadStatus(true);
