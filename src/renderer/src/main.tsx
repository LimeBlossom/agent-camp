import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { desktopView } from './desktop/view';
import { DesktopStrip } from './desktop/DesktopStrip';
import { DesktopAskMe } from './desktop/DesktopAskMe';
import { DesktopTalk } from './desktop/DesktopTalk';
import { snipView } from './snip/view';
import { SnipOverlay } from './snip/SnipOverlay';
import { SnipNote } from './snip/SnipNote';
import { branding } from './branding';
import './design/global.css';
import { setAppName } from './i18n';
import { loadInstalledThemePacks } from './scene/office/themePacks';
import { startInputLagProbe } from './perf/inputLagProbe';
import { installRendererErrorForwarding } from './rendererErrors';

installRendererErrorForwarding(window);

if (!desktopView && !snipView) startInputLagProbe((r) => window.cth.reportLag(r));

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
document.head.appendChild(favicon);

const splashImg = document.createElement('img');
splashImg.style.cssText = 'height:56px;width:auto;display:block';
document.querySelector('#cth-splash .mk')?.replaceWith(splashImg);

function applyBranding(): void {
  const { title, logo } = branding();
  favicon.href = logo;
  splashImg.src = logo;
  splashImg.alt = title;
  document.title = title;
  setAppName(title);
}
applyBranding();

if (desktopView) document.documentElement.classList.add('cth-desktop');
if (desktopView || snipView) document.getElementById('cth-splash')?.remove();

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

// Theme packs register before the first render: the floor, the cast and the
// branding all read the theme registry synchronously.
void loadInstalledThemePacks(window.cth).then(() => {
  applyBranding();
  createRoot(root).render(
    <StrictMode>
      {desktopView === 'strip' ? <DesktopStrip /> : desktopView === 'askme' ? <DesktopAskMe />
        : desktopView === 'talk' ? <DesktopTalk />
        : snipView === 'snip' ? <SnipOverlay /> : snipView === 'snipNote' ? <SnipNote /> : <App />}
    </StrictMode>
  );
});
