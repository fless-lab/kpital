// Build-time data: fetch the public catalog so Eleventy can render SEO HTML for
// the catalog and one fiche per project. If the API is unreachable (frontend-only
// CI), return [] so `npm run build` stays green and the client hydrates live.
const BASE = process.env.BUILD_API_URL || "http://localhost:3000";

async function fetchList(surface) {
  try {
    const res = await fetch(`${BASE}/projects/${surface}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.projects || []).map((p) => ({ ...p, surface }));
  } catch {
    return []; // API down at build: the page ships as a shell, client fills it.
  }
}

module.exports = async function () {
  const [funding, showcase] = await Promise.all([fetchList("funding"), fetchList("showcase")]);
  // Dedupe by id defensively (a project is only ever on one surface).
  const seen = new Set();
  return [...funding, ...showcase].filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
};
