export function Brand({ light = false }) {
  return <a className={`brand ${light ? 'brand-light' : ''}`} href="/" aria-label="BLEA AI beranda"><span className="brand-mark"><span /><span /><span /><span /></span><span>BLEA<span className="brand-ai">.AI</span></span></a>;
}
