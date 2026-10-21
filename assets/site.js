/* The Pacific Signal — shared core behaviour (index + article). Plain JS, no build step. */
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML}

/* Pretty URL builders */
function articleUrl(slug){return '/article/'+encodeURIComponent(slug)}
function sectionUrl(slug){return '/section/'+encodeURIComponent(slug)}

function timeAgo(ds){
  if(!ds)return'';
  var t=new Date(ds).getTime();if(isNaN(t))return'';
  var diff=Math.floor((Date.now()-t)/1000);
  if(diff<60)return'Just now';
  if(diff<3600){var m=Math.floor(diff/60);return m+(m>1?' mins':' min')+' ago'}
  if(diff<86400){var h=Math.floor(diff/3600);return h+(h>1?' hours':' hour')+' ago'}
  if(diff<604800){var d=Math.floor(diff/86400);return d+(d>1?' days':' day')+' ago'}
  return new Date(ds).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
}
function fmtDate(ds){return ds?new Date(ds).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}):''}
function fmtTime(ds){return ds?new Date(ds).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZoneName:'short'}):''}

/* Today's date in the utility bar */
(function(){
  var el=document.getElementById('utilDate');
  if(el)el.textContent=new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  var c=document.getElementById('ftCopy');
  if(c)c.innerHTML='&copy; '+new Date().getFullYear()+' The Pacific Signal. All rights reserved.';
})();

/* Sticky nav shadow */
(function(){
  var nav=document.getElementById('siteNav');if(!nav)return;
  window.addEventListener('scroll',function(){nav.classList.toggle('stuck',window.scrollY>140)},{passive:true});
})();

/* Highlight current section in nav */
function markNav(slug){
  var key=(slug===undefined||slug===null)?'home':slug;
  document.querySelectorAll('.nav-a').forEach(function(a){
    a.classList.toggle('on',a.getAttribute('data-nav')===key);
  });
}

/* Full-page menu */
function openMenu(){document.getElementById('fpMenu').classList.add('on');document.body.style.overflow='hidden'}
function closeMenu(){document.getElementById('fpMenu').classList.remove('on');document.body.style.overflow=''}

/* Theme — Classic (light) / Briefing (dark). Follows system, then remembers choice. */
function setTheme(mode){
  document.documentElement.setAttribute('data-theme',mode);
  try{localStorage.setItem('tps-theme',mode)}catch(e){}
  var l=document.getElementById('themeOptLight'),d=document.getElementById('themeOptDark');
  if(l&&d){l.classList.toggle('on',mode==='light');d.classList.toggle('on',mode==='dark')}
}
(function(){
  var saved=null;try{saved=localStorage.getItem('tps-theme')}catch(e){}
  setTheme(saved||(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
})();

/* Search — one cached index, typo-tolerant local matching */
var _idx=null,_st=null;
function loadSearchIndex(){
  if(!_idx)_idx=fetch('/api/search-index').then(function(r){return r.json()}).catch(function(){return []});
  return _idx;
}
function openSearch(){
  document.getElementById('searchOv').classList.add('on');
  document.body.style.overflow='hidden';
  loadSearchIndex();
  setTimeout(function(){document.getElementById('searchInput').focus()},50);
}
function closeSearch(){
  document.getElementById('searchOv').classList.remove('on');
  document.body.style.overflow='';
  document.getElementById('searchInput').value='';
  document.getElementById('searchResults').innerHTML='';
}
function onSearchInput(){
  clearTimeout(_st);
  var q=document.getElementById('searchInput').value.trim();
  if(q.length<2){document.getElementById('searchResults').innerHTML='';return}
  _st=setTimeout(function(){runSearch(q)},150);
}
function editDistance(a,b){
  if(a===b)return 0;var al=a.length,bl=b.length;if(!al)return bl;if(!bl)return al;
  var row=[];for(var i=0;i<=bl;i++)row[i]=i;
  for(var x=1;x<=al;x++){var prev=row[0];row[0]=x;
    for(var y=1;y<=bl;y++){var tmp=row[y];row[y]=a[x-1]===b[y-1]?prev:1+Math.min(prev,row[y],row[y-1]);prev=tmp}}
  return row[bl];
}
function tokenize(s){return(s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean)}
function fuzzyScore(qt,a){
  var hay=tokenize(a.title+' '+(a.excerpt||'')+' '+(a.category_name||'')),score=0;
  qt.forEach(function(q){var best=0;
    hay.forEach(function(h){
      if(h.indexOf(q)===0){best=Math.max(best,3);return}
      if(h.indexOf(q)!==-1){best=Math.max(best,2);return}
      if(editDistance(q,h)<=(q.length<=4?1:2))best=Math.max(best,1)});
    score+=best});
  return score;
}
async function runSearch(q){
  var c=document.getElementById('searchResults');
  c.innerHTML='<div class="search-empty">Searching&hellip;</div>';
  try{
    var index=await loadSearchIndex(),qt=tokenize(q);
    var res=index.map(function(a){return{a:a,s:fuzzyScore(qt,a)}}).filter(function(x){return x.s>0})
      .sort(function(x,y){return y.s-x.s}).slice(0,20).map(function(x){return x.a});
    if(!res.length){c.innerHTML='<div class="search-empty">No results for &ldquo;'+esc(q)+'&rdquo;.</div>';return}
    c.innerHTML=res.map(function(a){
      return '<a href="'+articleUrl(a.slug)+'" class="sr-item"><div class="sr-cat">'+esc(a.category_name||'')+'</div><div class="sr-ttl">'+esc(a.title)+'</div></a>';
    }).join('');
  }catch(e){c.innerHTML='<div class="search-empty">Search unavailable. Please try again.</div>'}
}
document.addEventListener('keydown',function(e){
  var t=document.activeElement.tagName;
  if(e.key==='/'&&t!=='INPUT'&&t!=='TEXTAREA'){e.preventDefault();openSearch()}
  if(e.key==='Escape'){closeSearch();closeMenu()}
});
