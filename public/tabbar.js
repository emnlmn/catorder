// phone tab bar (app.css, max-width 700px): away while you scroll down, back when you scroll up, near the top,
// at the end of the page and on a new view, as Safari, YouTube and Material bottom bars do
(() => {
  const nav = document.querySelector('.nav');
  let y0 = scrollY, run = 0; // run: distance scrolled in the current direction, so a jitter neither hides nor shows it
  const show = () => { run = 0; nav.classList.remove('away'); };
  addEventListener('scroll', () => {
    const y = scrollY, d = y - y0; y0 = y;
    run = (d > 0) === (run > 0) ? run + d : d;
    if (y < 64 || y + innerHeight > document.documentElement.scrollHeight - 8 || run < -24) show();
    else if (run > 24) nav.classList.add('away');
  }, { passive: true });
  new MutationObserver(show).observe(document.body, { attributes: true, attributeFilter: ['data-v'] });
})();
