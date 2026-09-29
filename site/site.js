(function(){
  var tabs=document.querySelectorAll('.tabs button'),img=document.getElementById('shot');
  tabs.forEach(function(t){t.addEventListener('click',function(){
    tabs.forEach(function(x){x.setAttribute('aria-selected',String(x===t))});
    img.src=t.dataset.img;img.alt=t.dataset.alt;
  })});
  var b=document.getElementById('copy1');
  b.addEventListener('click',function(){
    var txt=document.getElementById('cmd1').textContent;
    function sel(){var r=document.createRange();r.selectNodeContents(document.getElementById('cmd1'));var s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='selected';}
    try{navigator.clipboard.writeText(txt).then(function(){b.textContent='copied'},sel)}catch{sel()}
    setTimeout(function(){b.textContent='copy'},1800);
  });
})();
