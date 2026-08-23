# KPITAL Backend, sous-systeme 6 : Remboursement (echeancier, mocke, swappable)

> Document de conception (spec). Statut : brouillon a relire.
> Date : 2026-08-24. Se greffe sur Foundation + KYC + Projets + Investissement (#4) + Escrow (#5), tous merges dans `main`.

---

## 1. Objectif et perimetre

Fermer la boucle monetaire : une fois le projet `funded` et l'escrow libere vers le porteur (#5), le porteur rembourse principal + ROI **par tranches (echeancier)** sur la duree du projet, et chaque paiement est **distribue au pro-rata aux wallets des investisseurs**. L'argent entrant reste **mocke** derriere l'interface `PaymentProvider` (`initiateRepayment`), concue pour qu'un partenaire de paiement agree reel devienne un simple plugin remplacable, sans reecriture (meme principe que #5).

Decisions de cadrage (validees) :
- **Echeancier** (tranches mensuelles), PAS de logique de retard/penalite/defaut pour l'instant.
- Le **porteur paie** chaque tranche via le provider ; distribution pro-rata aux investisseurs.
- Collecte du remboursement **two-phase async-ready** (comme le depot #5) : `pending` puis reglement (mock instant / partenaire reel webhook) qui declenche la distribution.

**Dans le perimetre :**
- Generation de l'echeancier a `funded` (accroche a la fin de `releaseProject` de #5), passage `funded -> repaying`.
- `POST /projects/:id/repay` (porteur) : payer la prochaine tranche `due`, collecte two-phase.
- `POST /escrow/repayment` (webhook secret) : regler une tranche -> distribution pro-rata ; ou echec -> tranche `due`.
- Distribution pro-rata idempotente et reprenable (jamais de double-credit, jamais d'investisseur oublie).
- Passage `repaying -> closed` quand toutes les tranches sont `paid`.
- `GET /projects/:id/repayment-schedule` (porteur) ; `repaidMinor` ajoute a `GET /me/investments` (investisseur).
- `initiateRepayment` ajoute a `PaymentProvider` (+ impl mock).

**Hors perimetre : A TRAITER A LA CONCEPTION SUIVANTE (voir section 11).** Retard / penalite / defaut ; remboursement partiel ou anticipe d'une tranche ; regeneration d'echeancier si le montant change ; late-settlement d'un remboursement apres `closed`. Ces cas ne sont PAS des defauts de #6 : ils sont volontairement renvoyes au sous-systeme suivant (gestion des retards/defauts et cas limites de remboursement), et doivent y etre repris.

---

## 2. Decisions (issues du cadrage)

| Decision | Choix |
|---|---|
| Structure | **Echeancier** : N = `durationMonths` tranches mensuelles ; pas de retard/defaut (differe) |
| Total du | `total_owed = round(raised_minor * (1 + roiPct/100))` (entier FCFA) |
| Montant tranche | `total_owed / N` ; la **derniere tranche absorbe le reste** d'arrondi (somme = total_owed exact) |
| Qui paie | **Le porteur**, via `provider.initiateRepayment` (mock ok ; partenaire reel = mobile money) |
| Collecte | **Two-phase async-ready** : tranche `due -> pending` (rien distribue) puis reglement -> `paid` + distribution |
| Distribution | **Pro-rata** par part de principal (`amount_minor / raised_minor`), credit wallet `repayment` |
| Arrondi distribution | floor par investisseur + **plus fort reste** (departage par `investment.id`), somme = montant tranche exact |
| Idempotence distribution | table `repayment_distribution` avec `UNIQUE(installment_id, investment_id)` (garde par investisseur) |
| Declenchement echeancier | a la fin de `releaseProject` (#5), garde `funded -> repaying` + generation unique |
| Fin | `repaying -> closed` quand toutes les tranches sont `paid` |
| Paiement sequentiel | le porteur paie la **prochaine tranche `due`** (ordre `seq`), une a la fois |

FCFA n'a pas de sous-unite : les montants « minor » sont des entiers FCFA.

---

## 3. Machine a etats

**Projet** (existant) : `funded -> repaying` (a la generation de l'echeancier) `-> closed` (toutes tranches `paid`).

**Accroche `startRepayment(projectId)`** (seul ajout au code #5, appelee a la FIN de `releaseProject`) : elle ne bascule `funded -> repaying` QUE si la liberation est **complete**, c'est-a-dire qu'il ne reste **aucun investissement `escrowed`** (tous `released`). Si une liberation partielle a laisse des stragglers (echec provider sur un investissement), elle ne fait rien : le projet reste `funded` et une reprise de `releaseProject` (webhook rejoue) liberera le reste, puis basculera. Transition **gardee** `funded -> repaying` ; si elle change la ligne, generer l'echeancier une fois (N tranches, dues `funded_at + k mois`, `total_owed = round(raised * (1+roiPct/100))`, derniere tranche = reste). Idempotente. **Coherence critique avec la garde de `releaseProject` (durcissement #5 : `if status != "funded" return`)** : parce que le basculement n'a lieu qu'apres liberation complete, tant qu'il reste des stragglers le projet est `funded` et la reprise peut les liberer ; une fois `repaying`, il n'existe plus d'`escrowed`, donc court-circuiter un `releaseProject` redondant est correct. NE PAS basculer avant la fin de la liberation, sinon la garde bloquerait la reprise et laisserait de l'escrow non libere.

**Tranche (`repayment_installment.status`)** :
```
due --(porteur paie: initiateRepayment)--> pending --(reglement settled)--> paid
                                             |
                                (reglement failed) --> due   (reessayable)
```
- **due** : a payer, rien collecte.
- **pending** : collecte initiee (ref provider), pas encore reglee, rien distribue.
- **paid** : reglee ET distribuee pro-rata a tous les investisseurs.

La distribution n'arrive JAMAIS avant le reglement (comme #5 : `pending` ne distribue rien ; c'est `settled` qui declenche).

---

## 4. Modele de donnees (une migration)

**repayment_installment**
- `id` uuid pk
- `project_id` uuid fk -> project
- `seq` int (1..N, ordre de paiement)
- `amount_minor` bigint (montant de la tranche, entier FCFA)
- `due_at` timestamptz (`funded_at + seq mois`)
- `status` enum `repayment_installment_status` : `due` | `pending` | `paid` (defaut `due`)
- `repayment_ref` text null (ref provider de la collecte)
- `settled_at` timestamptz null
- `created_at` timestamptz

**repayment_distribution**
- `id` uuid pk
- `installment_id` uuid fk -> repayment_installment
- `investment_id` uuid fk -> investment
- `amount_minor` bigint (part distribuee a cet investisseur pour cette tranche)
- `created_at` timestamptz
- **`UNIQUE(installment_id, investment_id)`** : la garde d'idempotence de la distribution (insert-once).

Reutilise `project_status` (`repaying`/`closed` deja presents), `entry_type` (`repayment` deja present). Aucune recreation d'enum. Nouvel enum `repayment_installment_status` uniquement.

---

## 5. Couture provider

`PaymentProvider` (deja etendu en #5) gagne :
```ts
initiateRepayment(args: {
  payerAccountId: string;   // le porteur
  amountMinor: number;
  idempotencyKey: string;   // repay:<installmentId>
}): Promise<{ ok: boolean; ref: string; status: "pending" | "settled" }>
```
`MockPaymentProvider` : `repaymentMode: "settled" | "pending"` (defaut `settled`), meme memoisation par cle d'idempotence, refs `mock-repay-N`. `ok:false` = refus synchrone. Le partenaire reel implemente la meme methode : drop-in. Le webhook de remboursement reutilise le meme secret `ESCROW_WEBHOOK_SECRET`.

---

## 6. Endpoints et flux

Enveloppe d'erreur uniforme `{ error: { code, message, details? } }`.

**`POST /projects/:id/repay`** (auth ; owner du projet) :
1. Charger le projet ; `status != "repaying"` -> `409 invalid_state`.
2. Trouver la tranche NON `paid` de plus petit `seq` (`ORDER BY seq`). Aucune -> `409 invalid_state` (tout est paye). Si cette tranche est deja `pending` -> `409 invalid_state` (reglement en cours ; un seul en vol a la fois, ordre strict). Sinon elle est `due`.
3. Garde `due -> pending` sur la tranche (sous verrou de la ligne tranche pour serialiser deux `POST /repay` concurrents : un seul passe la garde, l'autre voit `pending` -> 409).
4. `initiateRepayment({ payerAccountId: ownerId, amountMinor: tranche.amount_minor, idempotencyKey: "repay:"+installmentId })`. Si `!ok` -> remettre la tranche `due` (rollback) et `402 repayment_failed`.
5. Enregistrer `repayment_ref`. Si `status === "settled"` : appeler `settleRepayment(installmentId)` (section 7). Si `pending` : renvoyer sans distribuer.
6. Reponse : `201 { installmentId, seq, amountMinor, status: "pending"|"paid", projectStatus }`.
- Codes : `invalid_state` 409, `repayment_failed` 402, non-owner -> 403, non-UUID -> 404.

**`POST /escrow/repayment`** (webhook, PAS d'auth session) : body `{ repaymentRef, status: "settled"|"failed" }`, verifie par `ESCROW_WEBHOOK_SECRET` via en-tete de signature ; secret absent/mauvais -> `401`. Idempotent.
- `settled` : `settleRepayment` (garde `pending -> paid` + distribution + close eventuel). Tranche deja reglee -> `200` no-op.
- `failed` : garde `pending -> due` (reversible, reessayable) ; ne distribue rien. -> `200`.
- `repaymentRef` inconnu -> `404`.

**`GET /projects/:id/repayment-schedule`** (auth ; owner) : `{ installments: [{ seq, amountMinor, dueAt, status, settledAt }], totalOwedMinor, paidCount, totalCount }`. Pas de PII investisseur.

**`GET /me/investments`** (existant #4/#5) : ajouter `repaidMinor` (somme des `repayment_distribution.amount_minor` recues par le caller pour cet investissement), pour que l'investisseur voie ce qu'il a deja touche.

---

## 7. Distribution pro-rata (crux monetaire) : `settleRepayment(installmentId)`

L'ensemble des investisseurs est **fige** : le projet est `funded`, tous les investissements sont `released`, aucun nouvel investissement possible. La base pro-rata (`raised_minor`, parts `p_i`) est stable, pas de concurrence dessus.

1. Charger la tranche ; charger tous les investissements du projet (part `p_i = investment.amount_minor`, `R = raised_minor`).
2. **Precalcul deterministe** des parts : `share_i = floor(A * p_i / R)` ; reste `A - Σ share_i` distribue une unite a la fois aux plus grosses parts fractionnaires, departage par `investment.id`. `Σ share_i = A` exact.
3. Pour **chaque investisseur**, dans sa propre courte transaction (HORS verrou long) : insert `repayment_distribution(installment_id, investment_id, amount_minor = share_i)` ; sur conflit `UNIQUE(installment_id, investment_id)` -> ne rien faire (deja distribue). Si l'insert a ajoute une ligne : crediter le wallet de l'investisseur (`walletEntries type="repayment", amount_minor = +share_i, reference = distributionId`) DANS LA MEME transaction. Un `share_i == 0` (petit investisseur, tranche petite) n'insere ni ne credite (rien a distribuer cette tranche).
4. Apres la boucle : garde `pending -> paid` (+`settled_at`) sur la tranche. Puis si **toutes** les tranches du projet sont `paid`, garde `repaying -> closed` sur le projet.

**Idempotence + reprise** : la distribution est gardee **par investisseur** (l'unicite `(installment_id, investment_id)`), PAS par le statut de la tranche. Un webhook rejoue, un crash en pleine distribution, un double callback : `settleRepayment` se re-execute, saute les credits deja faits (conflit), fait les manquants, puis re-marque `paid` et re-tente le close. Aucun double-credit, aucun investisseur oublie. Meme patron que la reprise de release de #5. Les credits par investisseur precedent la garde de la tranche, donc une tranche n'est jamais `paid` avant que sa distribution soit complete.

---

## 8. Securite / integrite

- **accountId** toujours de la session (`req.accountId`) ; `POST /repay` verifie que le caller est l'owner du projet (jamais un accountId du body). Le webhook agit uniquement via `repaymentRef`.
- **Webhook** verifie par secret partage (`ESCROW_WEBHOOK_SECRET`, defaut vide -> rejet), idempotent, ne fuit pas d'etat au-dela de l'existence de la ref.
- **Conservation** : `Σ distribue = montant de la tranche` exact (plus fort reste) ; `Σ tranches = total_owed` exact. Jamais de sur/sous-distribution en agregat.
- **Pas de double-mouvement** : garde d'unicite `(installment_id, investment_id)` + gardes d'etat (`due/pending/paid`) + cles d'idempotence provider `repay:<installmentId>`.
- **Pas d'I/O reseau sous verrou** : distribution par investisseur en courtes transactions hors verrou long (patron release/refund #5).
- **La distribution n'arrive jamais avant l'argent** : `pending` ne distribue rien ; seul `settled` declenche.
- **Credit investisseur** = wallet `repayment` positif (l'investisseur retire via le withdraw existant). Aucune PII/champ interne fuite.
- Montants entiers ; validations strictes ; `status` webhook valide.

---

## 9. Reutilisation

`PaymentProvider`/`MockPaymentProvider` (ajout `initiateRepayment` comme `initiateDeposit`) ; webhook secret + patron de #5 (route parallele `POST /escrow/repayment`) ; service wallet (insertion d'entree, patron) ; gardes d'etat + cles d'idempotence deterministes de #5 ; verrou projet + `releaseProject` (accroche `startRepayment` en fin) ; `requireAuth` + owner-check (patron des routes porteur Projets) ; enveloppe d'erreur + handler ; `buildTestApp` (mock injecte, secret webhook de test) ; projections publiques.

---

## 10. Tests

Fake payments (`initiateRepayment` instant-settle par defaut, mode `pending` pilotable) + `withTestDb`/`buildTestApp`.
- **Generation echeancier** : un projet qui atteint `funded` (via un invest qui complete la cible) -> N tranches generees, dues mensuelles, somme = total_owed, derniere absorbe le reste, projet `repaying`.
- **Chemin instant** : `POST /repay` (mock settled) -> tranche `paid`, distribution pro-rata creditee, wallets investisseurs credites `repayment`, somme distribuee = montant tranche.
- **Chemin async** : mock `pending` -> `POST /repay` renvoie `status=pending`, rien distribue ; `POST /escrow/repayment` `settled` -> distribution ; **webhook rejoue** -> distribution une seule fois (idempotence, contrainte unique) ; `settled` sur tranche deja payee -> no-op.
- **Reglement failed** : `POST /escrow/repayment` `failed` -> tranche `due` (reessayable), rien distribue.
- **Pro-rata + arrondi** : parts inegales (ex. 3 investisseurs 500k/300k/200k, tranche impaire) -> floors + plus fort reste, somme = montant tranche exact, departage deterministe.
- **Cloture** : payer toutes les tranches -> projet `closed`, un `POST /repay` suivant -> `409`.
- **Auth** : non-owner -> 403 ; projet non `repaying` -> 409 ; webhook non signe -> 401 ; repaymentRef inconnu -> 404.
- **`repaidMinor`** expose sur `/me/investments` ; **`GET /repayment-schedule`** owner-only.
- **Concurrence** (patron #5) : deux reglements concurrents de la meme tranche -> serialises/gardes, distribution une seule fois.

---

## 11. Questions ouvertes / defauts, et A TRAITER A LA CONCEPTION SUIVANTE

Reportes volontairement au sous-systeme suivant (gestion des retards/defauts et cas limites de remboursement). Ce ne sont PAS des defauts de #6.

1. **Retard / penalite / defaut** : une tranche `due` dont `due_at` est passee reste `due` payable ; aucune relance, penalite, interet de retard, ni marquage de defaut. -> conception suivante.
2. **Remboursement partiel / anticipe** : une tranche se paie en entier ; pas de paiement partiel ni de solde anticipe de plusieurs tranches d'un coup. -> conception suivante.
3. **Regeneration d'echeancier** : l'echeancier est genere une fois a `funded` et fige ; pas de re-calcul si un montant change (le montant ne change pas en #6). -> conception suivante.
4. **Late-settlement apres `closed`** : le mock regle en synchrone, donc un reglement de remboursement arrivant apres cloture ne peut pas se produire en #6 ; avec un partenaire reel async, un reglement tardif devra etre gere (idempotent, mais l'etat cible sera `closed`). -> conception suivante / integration partenaire reel.
5. **Derive d'arrondi par investisseur** : le total recu par un investisseur peut derive de quelques unites de `p_i * (1+roi)` theorique (arrondi par tranche). Conservation exacte en agregat par tranche. Defaut acceptable ; un lissage final (derniere tranche ajuste par investisseur) serait un raffinement. -> conception suivante si souhaite.
6. **Refus de collecte cote provider** (`initiateRepayment` ok:false ou reglement failed) : la tranche revient `due` et est reessayable par le porteur ; pas de relance automatique. Le mock ne refuse jamais. -> integration partenaire reel.
