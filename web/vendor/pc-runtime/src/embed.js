// <pc-embed ref="pc://tasks/task/123" size="inline|card">: shows another app's item inside this one.
// It reads the owning app's manifest, loads that app's embed module, and puts the app's own element
// (e.g. <taskwell-task>) in its shadow root. If anything fails it shows a plain link instead.
//
//   import { connect } from '@awestley/pc-runtime';
//   import { defineEmbed } from '@awestley/pc-runtime/embed';
//   defineEmbed(connect({ app: 'notes' }));
//
// The embedded element announces "open me" by dispatching a bubbling, composed `pc-open` event
// with detail { ref }; <pc-embed> passes it to the shell, which opens the item in a new column.
import { parseRef } from './refs.js';

const manifests = new Map();
const modules = new Map();

export function loadManifest(appId, fetchImpl = globalThis.fetch) {
  if (!manifests.has(appId)) {
    const p = fetchImpl(`/apps/${appId}/manifest.json`, { credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error(`manifest ${r.status}`); return r.json(); });
    p.catch(() => manifests.delete(appId));
    manifests.set(appId, p);
  }
  return manifests.get(appId);
}

/** The custom element tag an app uses for a type, after loading its embed module. */
export async function embedTagFor(ref, { fetchImpl, importImpl = (u) => import(u) } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) throw new Error('Invalid reference');
  const manifest = await loadManifest(parsed.app, fetchImpl);
  const entity = (manifest.entities || []).find((e) => e.type === parsed.type);
  if (!entity?.embed || !manifest.embedModule) throw new Error('Not embeddable');
  if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(entity.embed)) throw new Error('Bad embed tag');
  const url = new URL(manifest.embedModule, globalThis.location?.href);
  if (globalThis.location && url.origin !== globalThis.location.origin) throw new Error('Embed module must be same-origin');
  if (!modules.has(url.href)) modules.set(url.href, importImpl(url.href));
  await modules.get(url.href);
  return { tag: entity.embed, manifest, parsed };
}

export function defineEmbed(pc, { name = 'pc-embed' } = {}) {
  if (customElements.get(name)) return;
  customElements.define(name, class PcEmbed extends HTMLElement {
    static observedAttributes = ['ref', 'size'];

    connectedCallback() {
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
        this.addEventListener('pc-open', (e) => {
          e.stopPropagation();
          pc.open(e.detail?.ref || this.getAttribute('ref'), { placement: 'new-column' });
        });
      }
      this.render();
    }

    attributeChangedCallback() { if (this.isConnected && this.shadowRoot) this.render(); }

    async render() {
      const ref = this.getAttribute('ref');
      const size = this.getAttribute('size') === 'card' ? 'card' : 'inline';
      const token = Symbol('render');
      this._token = token;
      try {
        const { tag } = await embedTagFor(ref);
        if (this._token !== token) return;
        const el = document.createElement(tag);
        el.setAttribute('ref', ref);
        el.setAttribute('size', size);
        this.shadowRoot.replaceChildren(el);
      } catch {
        if (this._token !== token) return;
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = this.textContent.trim() || ref || 'Missing reference';
        a.style.color = 'var(--text-accent)';
        a.addEventListener('click', (e) => { e.preventDefault(); if (ref) pc.open(ref); });
        this.shadowRoot.replaceChildren(a);
      }
    }
  });
}

/** For tests. */
export function _resetEmbedCaches() { manifests.clear(); modules.clear(); }
