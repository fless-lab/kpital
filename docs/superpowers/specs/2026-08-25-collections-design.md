# KPITAL Backend, sous-systeme 7 : Retards et defauts de remboursement (soft, extensible)

> Document de conception (spec). Statut : brouillon a relire.
> Date : 2026-08-25. Se greffe sur Foundation + KYC + Projets + Investissement (#4) + Escrow (#5) + Remboursement (#6), tous merges dans `main`.

---

## 1. Objectif et perimetre

Gerer le retard et le defaut de remboursement. Une tranche d'echeancier (#6) dont l'echeance est passee et qui n'est pas payee est **en retard** ; le porteur est **relance** ; au-dela d'un delai de grace configurable, le projet passe en **defaut**. Approche **soft** : relances + marquage de defaut, **aucune penalite monetaire en #7**, mais une couture `PenaltyPolicy` extensible est posee pour brancher un frais fixe ou un interet plus tard **sans reecriture**.

Decisions de cadrage (validees) :
- Perimetre = **retards + defauts seuls** (le remboursement partiel/anticipe est un #8 distinct).
- Penalite : **soft** (relances + defaut, penalite = 0), derriere une couture `PenaltyPolicy` (`NoPenaltyPolicy` aujourd'hui), parametrable plus tard.
- Defaut : une tranche en retard au-dela de `DEFAULT_GRACE_DAYS` (defaut 30) fait passer le projet en `defaulted` ; plus un override admin (marquer / lever).
- Materialisation par un **sweep** (mock du cron quotidien), declenche par un endpoint admin, idempotent.

**Dans le perimetre :**
- `runRepaymentSweep` : relances (tranche `due` overdue, une fois, anti-spam via `reminded_at`), auto-`defaulted` au-dela de la grace, auto-reprise `defaulted -> repaying` quand les retards sont soldes.
- Couture `PenaltyPolicy` + `NoPenaltyPolicy` (0), injectee comme les autres dependances ; point d'accroche appele par le sweep.
- Endpoints : `POST /admin/repayment/sweep`, `POST /admin/projects/:id/default`, `POST /admin/projects/:id/undefault`.
- `POST /projects/:id/repay` (#6) modifie : accepte `repaying` OU `defaulted` ; auto-lift apres un settle qui solde les retards.
- Reads : `overdue` (derive) + `remindedAt` par tranche sur `GET /repayment-schedule` ; statut projet `defaulted` deja visible.
- Config `DEFAULT_GRACE_DAYS`, `PENALTY_POLICY` ; enum `project_status += defaulted` ; `reminded_at` sur la tranche ; (`defaulted_at` audit sur project).

**Hors perimetre : A TRAITER A LA CONCEPTION SUIVANTE (section 11).** Activation reelle de la caution/garantie a la defaut (saisie, indemnisation) ; recouvrement ; la collecte + distribution effective d'une penalite non-nulle (quand une `PenaltyPolicy` non-`none` arrivera) ; cadence de relance configurable fine (re-relances) ; plus les reports #5/#6 encore ouverts (integration provider reel : initiateDeposit hors verrou, orphaned-deposit, declined-refund resume, late-settlement apres closed ; remboursement partiel/anticipe = #8). Ce ne sont PAS des defauts de #7 : volontairement renvoyes.

---

## 2. Decisions (issues du cadrage)

| Decision | Choix |
|---|---|
| Perimetre | Retards + defauts seuls (partiel/anticipe = #8) |
| Penalite | **Soft** (0) derriere `PenaltyPolicy` (`NoPenaltyPolicy`), parametrable plus tard |
| Overdue | **Derive** (`status="due" && due_at < maintenant`), pas un etat stocke |
| Relance | Une fois par tranche overdue (`reminded_at` horodate, anti-spam), au **porteur**, notifier + `notification_pref` |
| Defaut | Tranche `due` avec `due_at + DEFAULT_GRACE_DAYS < maintenant` -> projet `repaying -> defaulted` + notifier **investisseurs** |
| Seuil defaut | `DEFAULT_GRACE_DAYS` (defaut 30), config |
| Reprise | Auto `defaulted -> repaying` quand plus aucune tranche overdue-au-dela-de-grace ; + override admin |
| Materialisation | `runRepaymentSweep` (mock du cron quotidien), endpoint admin, idempotent (gardes + `reminded_at`) |
| Argent | **Aucun flux d'argent en #7** (penalite = 0) |

FCFA entier ; « maintenant » = `new Date()` serveur ; les tests sement des `due_at` passes pour piloter le temps.

---

## 3. Cycle retard / relance / defaut

`overdue` est **derive** (pas stocke) : une tranche `#6` `due` dont `due_at < maintenant`. Etats de tranche inchanges (`due / pending / paid`). Ce que le sweep **materialise** : relances + transitions projet.

```
tranche due, due_at < maintenant                 -> OVERDUE (derive)
  sweep -> relance porteur (une fois)            -> reminded_at = maintenant
  due_at + GRACE_DAYS < maintenant (sweep)       -> projet repaying -> DEFAULTED + notifier investisseurs
projet defaulted, plus de tranche overdue-au-dela-de-grace (sweep, ou apres /repay) -> repaying (reprise)
```

**Projet** (existant) : `repaying <-> defaulted` (aller par le sweep ou l'admin ; retour par la reprise auto ou l'admin). `closed` inchange (toutes tranches `paid`). Un projet `defaulted` accepte toujours `/repay`.

Idempotence partout : `reminded_at` non-null -> pas de re-relance ; garde `repaying -> defaulted` / `defaulted -> repaying` -> un re-sweep ne renotifie/ne retransitionne pas.

---

## 4. Couture `PenaltyPolicy`

```ts
export interface PenaltyPolicy {
  // Penalite due (FCFA entier) pour une tranche en retard. 0 aujourd'hui.
  penaltyFor(args: { installmentId: string; amountMinor: number; daysLate: number }): number;
}
export class NoPenaltyPolicy implements PenaltyPolicy {
  penaltyFor(): number { return 0; }
}
```
Injectee par `buildApp({ ... penalty? })` (defaut `NoPenaltyPolicy`), selectionnee par `PENALTY_POLICY` (`none` aujourd'hui). Le sweep appelle `penaltyFor(...)` pour chaque tranche overdue ; comme c'est 0, **aucune ecriture d'argent**. Le calcul, la collecte et la distribution d'une penalite non-nulle s'activeront quand une policy `flat`/`interest` arrivera (section 11) ; la place est deja la, le cycle ne changera pas.

---

## 5. Le sweep (`runRepaymentSweep`)

`runRepaymentSweep(db, notifier, penalty): Promise<{ remindersSent, defaulted, recovered }>`. Mock du cron quotidien ; un vrai deploiement le cablera sur un scheduler. Idempotent. Par balayage :

1. **Relances.** Tranches `due` d'un projet `repaying`/`defaulted` avec `due_at < maintenant` et `reminded_at IS NULL` : notifier le **porteur** (notifier, `notification_pref`), poser `reminded_at = maintenant`. Une relance par tranche en #7 (re-relances = §11). `reminded_at` non-null -> saute.
2. **Defaut.** Projets `repaying` ayant au moins une tranche `due` avec `due_at + DEFAULT_GRACE_DAYS < maintenant` : garde `repaying -> defaulted` ; si la ligne change, `defaulted_at = maintenant` et notifier les **investisseurs** du projet. Idempotent.
3. **Reprise.** Projets `defaulted` sans aucune tranche `due` overdue-au-dela-de-grace restante : garde `defaulted -> repaying` (`defaulted_at = NULL`). (L'admin peut aussi lever a la main.)
4. **Penalite (place reservee).** Pour chaque tranche overdue, `penalty.penaltyFor({...})` est appele ; `NoPenaltyPolicy` -> 0 -> aucune ecriture. Point d'accroche pour plus tard.

Le resume `{ remindersSent, defaulted, recovered }` sert l'observabilite et les tests. Le sweep n'a pas de verrou long : transitions gardees par projet, relances gardees par tranche.

---

## 6. Endpoints

Enveloppe d'erreur uniforme `{ error: { code, message, details? } }`.

- `POST /admin/repayment/sweep` (requireAdmin) : lance `runRepaymentSweep`, `200 { remindersSent, defaulted, recovered }`.
- `POST /admin/projects/:id/default` (requireAdmin) : garde `repaying -> defaulted` (sinon `409 invalid_state`) ; pose `defaulted_at` et **`admin_defaulted = true`** ; notifie les investisseurs ; `200 { ok: true }`. Non-UUID -> 404 ; projet absent -> 404.
- `POST /admin/projects/:id/undefault` (requireAdmin) : garde `defaulted -> repaying` (sinon `409 invalid_state`) ; efface `defaulted_at` et remet **`admin_defaulted = false`** ; `200 { ok: true }`.
- `POST /projects/:id/repay` (existant #6, auth + owner) : **modifie** pour accepter `status IN (repaying, defaulted)` (sinon `409 invalid_state`) ; apres un `settled` qui laisse zero tranche overdue-au-dela-de-grace **et si `admin_defaulted = false`**, **auto-lift** garde `defaulted -> repaying` (helper #7). Le reste du flux (deux phases, strict sequentiel) inchange.

**Defaut admin collant (`admin_defaulted`).** Decision issue de la revue de #7 : un defaut prononce a la main par un admin (`POST /admin/projects/:id/default`) est **collant** et n'est jamais leve automatiquement (ni par la reprise du sweep, ni par l'auto-lift de `/repay`), seulement par `POST /admin/projects/:id/undefault`. La couture : une colonne `project.admin_defaulted` (bool, defaut false) posee `true` par la voie admin ; la phase de reprise du sweep (section 5.3) et l'auto-lift de `/repay` excluent `admin_defaulted = true` de leurs candidats. Le defaut par le sweep (section 5.2, driven par l'echeancier) laisse `admin_defaulted = false`, donc reste auto-reprenable. Ainsi les deux leviers sont coherents : le sweep gere le defaut/reprise pilote par l'echeancier ; l'admin gere le defaut/reprise manuel (pour les cas que l'echeancier ne capte pas : fraude, porteur disparu).
- `GET /projects/:id/repayment-schedule` (existant #6, owner) : ajouter par tranche `overdue` (derive `status="due" && due_at < maintenant`) et `remindedAt`. Toujours pas de PII investisseur. Le statut projet `defaulted` est visible cote porteur (schedule) et investisseur (`/me/investments` projette `project.status`).

---

## 7. Modele de donnees (migrations additives)

- `repayment_installment` : ajouter `reminded_at` timestamptz null (migration 0015).
- `project` : ajouter `defaulted_at` timestamptz null (audit, migration 0015).
- `project_status` enum : ajouter la valeur `defaulted` (migration 0015).
- `project` : ajouter `admin_defaulted` boolean not null default false (migration 0016 ; defaut admin collant, voir section 6).
- Reutilise `entry_type`, `notification_pref`, le notifier. `PenaltyPolicy` = interface en code (`api/src/lib/penalty/`), pas une table.

---

## 8. Securite / integrite

- `sweep`, `default`, `undefault` = **requireAdmin**. `/repay` reste auth + owner (jamais un accountId du body).
- Transitions **gardees** (`WHERE status = <attendu>`) -> idempotentes ; relances gardees par `reminded_at`.
- **Aucun flux d'argent** en #7 (penalite = 0). Le point d'accroche `PenaltyPolicy` ne bouge rien tant qu'il renvoie 0.
- Notifs via le notifier existant en **respectant `notification_pref`** (relance -> porteur ; defaut -> investisseurs). Aucune PII/champ interne fuite.
- `overdue` derive, jamais depuis le body ; « maintenant » serveur.
- Le sweep n'a pas de verrou long ; les transitions par projet sont serialisables (garde). Pas d'I/O reseau sous verrou (notifs hors transaction de garde, patron etabli).

---

## 9. Reutilisation

Notifier + `notification_pref` (Foundation) ; `requireAdmin` (Foundation) ; le patron de garde d'etat + idempotence de #5/#6 ; l'echeancier #6 (`repayment_installment`, `due_at`) ; le routeur repayment (#6) pour `/repay` et l'ajout des routes admin ; `buildApp` injection (comme notifier/payments) pour `penalty` ; `buildTestApp` (fake notifier + injection penalty + control du temps par `due_at` seme) ; enveloppe d'erreur + handler.

---

## 10. Tests

Fake notifier (capture) + `withTestDb`/`buildTestApp` + `due_at` semes dans le passe.
- **Relance** : projet `repaying` avec une tranche `due` `due_at` passe (< grace) -> sweep -> une notif au porteur, `reminded_at` pose ; re-sweep -> aucune nouvelle notif (anti-spam).
- **Defaut** : tranche `due` `due_at + GRACE < maintenant` -> sweep -> projet `defaulted`, `defaulted_at` pose, notif aux investisseurs ; re-sweep -> pas de re-notif ; `remindersSent/defaulted` du resume corrects.
- **Reprise** : projet `defaulted`, la tranche en retard passe `paid` (via /repay ou insertion) -> sweep -> `defaulted -> repaying` ; et via `/repay` : un settle qui solde le dernier retard auto-lift immediatement.
- **Grace** : une tranche overdue mais `< GRACE` -> relance mais **pas** de defaut.
- **Admin** : `default` garde repaying->defaulted (409 si deja/mauvais etat), `undefault` l'inverse ; non-admin -> 403.
- **/repay sur defaulted** : un projet `defaulted` accepte `/repay` (pas de 409) ; le reste du flux #6 intact.
- **Reads** : `overdue` + `remindedAt` exposes par tranche (owner) ; non-owner -> 403 ; investisseur voit `project.status="defaulted"` sur `/me/investments`.
- **Penalite** : `NoPenaltyPolicy` -> aucune ecriture d'argent lors d'un sweep sur des tranches overdue (aucune nouvelle entree wallet, aucun montant du modifie).
- **Prefs** : un porteur/investisseur qui a coupe un canal ne recoit pas la relance/notif sur ce canal (respect `notification_pref`).

---

## 11. Questions ouvertes / defauts, et A TRAITER A LA CONCEPTION SUIVANTE

Reportes volontairement. Ce ne sont PAS des defauts de #7.

1. **Caution / garantie reelle a la defaut** : saisie de la caution (le projet a un `caution_type`), indemnisation des investisseurs sur la garantie, processus de recouvrement. -> conception suivante.
2. **Penalite non-nulle** : le calcul est deja appele via `PenaltyPolicy`, mais la **collecte** de la penalite aupres du porteur et sa **distribution** aux investisseurs (ou a la plateforme) restent a construire quand une policy `flat`/`interest` arrivera (nouveau flux d'argent + politique de montant + destination). -> conception suivante.
3. **Cadence de relance fine** : en #7 une relance par tranche (`reminded_at` unique). Re-relances periodiques (tous les N jours), escalade, canaux differencies. -> conception suivante.
4. **Scheduler reel** : `runRepaymentSweep` est declenche par un endpoint admin (mock du cron). Le cablage d'un vrai scheduler quotidien (et sa robustesse/observabilite) est un sujet d'infra. -> deploiement.
5. **Reports #5/#6 encore ouverts** : integration provider reel (initiateDeposit hors verrou invest, orphaned-deposit reconciliation, declined-refund resume, late-settlement apres closed) ; remboursement partiel/anticipe (#8) ; lissage d'arrondi par investisseur. -> conceptions suivantes / integration partenaire reel.
