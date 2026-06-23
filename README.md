# KPITAL

Site de **KPITAL** — plateforme d'investissement participatif ancrée dans l'économie réelle togolaise (dès 10 000 FCFA, fonds sécurisés par séquestre SEMOA).

Statique, généré avec [Eleventy](https://www.11ty.dev/). HTML / CSS / JS, sans framework, URLs propres (sans `.html`).

## Démarrer

```bash
npm install
npm run dev      # http://localhost:8080
npm run build    # génère _site/ (à déployer)
```

## Structure

- `src/` — pages (`*.html`), `_includes/` (layout, nav, footer, SEO), `_data/site.json` (config), `assets/` (css, js, icônes, image de partage)
- `_site/` — build à déployer (Netlify, Vercel, Cloudflare Pages, GitHub Pages…)

Domaine et comptes sociaux se règlent dans **`src/_data/site.json`**.
