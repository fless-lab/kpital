# KPITAL Backend, sous-systeme 5 : Sequestre (escrow) mocke, swappable

> Document de conception (spec). Statut : brouillon a relire.
> Date : 2026-08-23. Se greffe sur Foundation + KYC + Projets + Investissement (#4), tous merges dans `main`.

---

## 1. Objectif et perimetre

Introduire un vrai cycle de sequestre pour les investissements : les fonds d'un investisseur sont **retenus en sequestre** par investissement pendant la collecte, **liberes** vers le porteur quand le projet atteint son objectif, ou **rembourses** aux investisseurs si l'admin annule la collecte. Le mouvement d'argent reste **mocke** derriere une interface `EscrowProvider`, concue pour qu'un partenaire de paiement agree reel devienne un simple **plugin remplacable** (une classe adaptateur + un choix de config), sans retoucher la machine a etats, les routes, ni la comptabilite.

Decision de cadrage (validee) : #5 = **sequestre uniquement** (retenue / liberation / remboursement), structure **pret pour l'asynchrone**. Le cycle de **remboursement du pret** (funded -> repaying -> closed, distributions ROI aux investisseurs) est le **#6**, hors perimetre ici.

**Dans le perimetre :**
- Reprise du flux #4 `POST /projects/:id/invest` en machine a etats de sequestre a deux phases (depot async-ready).
- Interface `EscrowProvider` (initiateDeposit / releaseEscrow / refundEscrow) avec cles d'idempotence ; impl `MockEscrowProvider` synchrone.
- Endpoint de reglement (webhook) `POST /escrow/settlement` verifie par secret partage, idempotent.
- Liberation automatique vers le wallet du porteur a l'objectif ; remboursement admin `POST /admin/projects/:id/cancel`.
- Liberation et remboursement executes **hors du verrou projet** (comme le payout Foundation), idempotents.

**Hors perimetre (reference, #6) :**
- Remboursement du pret (echeancier, distributions ROI), transitions funded -> repaying -> closed, credits wallet des remboursements.
- Deadline de collecte auto-echue (option ecartee pour #5 ; annulation admin seulement).
- Portail de disbursement admin (liberation gatee) : ecartee ; liberation auto a l'objectif.

---

## 2. Decisions (issues du cadrage)

| Decision | Choix |
|---|---|
| Perimetre | Sequestre seul (retenue/liberation/remboursement) ; remboursement du pret = #6 |
| Modele de reglement | **Deux phases, pret async.** payment : investment `pending` -> depot initie -> `escrowed` au reglement. wallet : reglement synchrone (grand livre interne). |
| Liberation | **Auto a l'objectif** (raised == target -> `funded`), escrow libere vers le wallet du porteur. Pas de gate admin de disbursement. |
| Remboursement | **Action admin** : annuler un projet en `collecting` rembourse chaque investissement retenu vers sa source. Pas de deadline auto. |
| Destination remboursement | **A la source** : wallet-source -> credit wallet ; payment-source -> `provider.refundEscrow`. |
| Increment de collecte | `raised_minor` avance **au reglement** (`pending`/instant -> `escrowed`), sous le verrou `FOR UPDATE` du projet ; il **decroit** au remboursement. |
| Idempotence | Transitions **gardees** (`WHERE status = <attendu>`) + cle d'idempotence sur chaque appel provider. Pas de table dediee. |
| Execution liberation/remboursement | **Hors du verrou projet**, en transactions courtes par investissement, idempotentes (principe payout Foundation : pas d'I/O reseau sous verrou). |

FCFA n'a pas de sous-unite : les montants « minor » sont des entiers FCFA.

---

## 3. Machine a etats de l'investissement

```
                       +-- (payment) -- pending --settle--+
POST invest -----------|                                  +--> escrowed --+-- release --> released
                       +-- (wallet) --- regle instant ----+               +-- refund  --> refunded
                                                                                            ^
                                                            (settle=failed) --> failed      |
                                                                              (admin cancel)+
```

- **pending** (payment uniquement) : investment enregistre, depot escrow initie chez le provider (ref + cle d'idempotence), `raised_minor` NON encore bouge.
- **escrowed** : depot regle (mock : instant ; partenaire reel : webhook). C'est ICI que `raised_minor` s'incremente sous le verrou `FOR UPDATE` du projet, et que le passage `funded` a l'objectif est teste. Fonds retenus, attribues a l'investissement.
- **released** (terminal) : projet a atteint l'objectif -> escrow libere vers le wallet du porteur (entree `disbursement`).
- **refunded** (terminal) : admin a annule la collecte -> investissement rembourse a sa source ; `raised_minor` decremente.
- **failed** (terminal) : un depot `pending` que le provider decline finalement (webhook `status=failed`) ; ne touche jamais `raised_minor`.

Invariants preserves de #4 : anti-surfinancement par verrou `FOR UPDATE` sur la ligne projet + contrainte DB `CHECK (raised_minor >= 0 AND raised_minor <= target_minor)` (migration 0010) ; l'increment se deplace simplement a l'etape de reglement.

---

## 4. Interface plugin `EscrowProvider`

Toute la logique (machine a etats, comptabilite) vit de **notre** cote ; seuls les mouvements d'argent traversent la couture.

```ts
interface EscrowProvider {
  // Commence a retenir les fonds de l'investisseur. Mock : renvoie settled
  // instantanement ; partenaire reel : renvoie pending puis regle via webhook.
  initiateDeposit(args: {
    accountId: string; amountMinor: number; method?: string; idempotencyKey: string;
  }): Promise<{ ref: string; status: "pending" | "settled" }>;

  // Libere les fonds retenus vers le porteur (a l'objectif).
  releaseEscrow(args: {
    depositRef: string; payeeAccountId: string; amountMinor: number; idempotencyKey: string;
  }): Promise<{ ref: string; ok: boolean }>;

  // Rend les fonds retenus a l'investisseur (remboursement payment-source).
  refundEscrow(args: {
    depositRef: string; amountMinor: number; idempotencyKey: string;
  }): Promise<{ ref: string; ok: boolean }>;
}
```

Principes qui font du partenaire un vrai drop-in :
- **Cles d'idempotence sur chaque appel**, generees par nous et **deterministes** (derivees de `investmentId` + nom d'operation, donc recalculables, non stockees). Un depot/liberation/remboursement rejoue, ou un webhook envoye deux fois, ne bouge jamais l'argent deux fois. Le mock memorise les cles et renvoie le resultat anterieur au rejeu ; l'adaptateur reel les transmet au mecanisme d'idempotence du partenaire.
- **`initiateDeposit` renvoie un statut**, pas un fait regle. Le service branche sur `pending` vs `settled`. Le mock renvoie `settled` par defaut (les tests semblent synchrones) ; un test peut le basculer en `pending` puis piloter le callback de reglement, exercant exactement le cablage du futur webhook, sans partenaire.
- **La couture est la seule chose qui change plus tard.** Cabler un partenaire = ecrire `SemoaEscrowProvider implements EscrowProvider` + config pour le selectionner (comme `NOTIFY_CHANNELS` / `StorageProvider`). Zero changement machine a etats / routes / comptabilite.

`MockEscrowProvider` implemente les trois de facon synchrone ; refs `mock-deposit-N` / `mock-release-N` / `mock-refund-N`. Le wallet-source ne touche jamais le provider (grand livre interne seul). Selection via config (ex. `ESCROW_PROVIDER=mock|semoa`), defaut `mock` ; injecte par `buildApp({ payments })` comme les autres dependances.

Note d'implementation : concretement c'est le `PaymentProvider` de #4 qui evolue en superset (il garde `payout` pour les retraits wallet), pas une seconde interface separee. Les trois methodes ci-dessus sont ajoutees/substituees dessus ; le nom `EscrowProvider` designe cette facette escrow du meme provider injecte.

---

## 5. Modele de donnees (migration 0011)

Pas de table de solde escrow : la somme des investissements `escrowed` d'un projet EST le montant retenu, et `raised_minor` le suit deja.

**investment** (existant, #4) :
- `status` enum : nouvelles valeurs `pending` / `escrowed` / `released` / `refunded` / `failed`, defaut `pending`. (Pas de donnee prod ; l'ancienne valeur `confirmed` reste dans l'enum, morte mais inoffensive, Postgres ne pouvant pas retirer une valeur d'enum a bas cout. La migration generee sera ajustee a la main pour rester propre.)
- Reutiliser `payment_ref` existant comme **ref de depot**.
- Ajouter `resolution_ref` text null (ref provider de liberation OU de remboursement ; `status` dit lequel), `settled_at` timestamptz null, `resolved_at` timestamptz null.

**project** (existant) :
- `status` enum : ajouter la valeur terminale `cancelled` (voie annulation admin). `funded` inchange (voie liberation).

**wallet_entry** (existant) :
- `type` enum : ajouter `disbursement` (credit positif au wallet du porteur a la liberation) et `refund` (credit positif de retour a un investisseur wallet-source). Le debit d'invest wallet-source reste l'entree negative `reinvestment` existante.

**Idempotence sans table.** Chaque transition est un update **garde** dans la transaction verrouillee du projet :
- reglement : `UPDATE investment SET status='escrowed', settled_at=now() WHERE id=? AND status='pending'` ; `raised_minor` s'incremente uniquement si cet update a reellement change une ligne. Un webhook envoye deux fois est un no-op la seconde fois.
- liberation / remboursement : meme garde (`WHERE status='escrowed'`). Un double callback, un retry, un webhook rejoue ne peuvent jamais rebouger l'argent : la garde d'etat + le verrou `FOR UPDATE` donnent l'idempotence gratuitement.

Une migration (0011) : extensions d'enum (investment_status, project_status, wallet_entry type), trois colonnes nullables sur investment, changement de defaut de `investment.status`.

---

## 6. Endpoints et flux

Enveloppe d'erreur uniforme `{ error: { code, message, details? } }`.

**`POST /projects/:id/invest`** (auth ; KYC verified) : revu. Body inchange `{ amountMinor, source: "payment"|"wallet", method?, confirmCapToRemaining? }`.
- wallet-source : sous le verrou projet, verifier le solde (verrou wallet FOR UPDATE), ecrire l'entree negative `reinvestment`, inserer investment `escrowed`, incrementer `raised_minor`, tester `funded`. Reglement instantane.
- payment-source : sous le verrou projet, valider (KYC, etat, min-ticket, reste/cap), inserer investment `pending`, puis `initiateDeposit` (cle = `deposit:<investmentId>`). Si le provider renvoie `settled` (defaut mock) : appliquer immediatement la transition de reglement (escrowed + raised++ + funded check + liberation eventuelle). Si `pending` : renvoyer sans bouger `raised_minor`.
- Reponse : `201 { investmentId, amountMinor, status: "escrowed"|"pending", raisedMinor, projectStatus, depositRef }`.
- Un refus synchrone du provider a l'initiation -> `402 payment_failed`, aucune ligne investment (comme #4). Codes conserves : `kyc_required` 403, `below_min_ticket` 400, `exceeds_remaining` 409 (+`details.remainingMinor`), `invalid_state` 409, `insufficient_funds` 400, `payment_failed` 402.

**`POST /escrow/settlement`** (webhook, PAS d'auth session) : body `{ depositRef, status: "settled"|"failed" }`, verifie par secret partage config-driven (`ESCROW_WEBHOOK_SECRET`) via en-tete de signature ; secret absent/mauvais -> `401`. Idempotent.
- `settled` : dans une transaction avec verrou `FOR UPDATE` du projet lie, transition gardee `pending -> escrowed` (+`settled_at`), increment `raised_minor`, test `funded` ; si `funded`, declenche la liberation (section 7). Depot deja regle (garde ne matche pas) -> `200` no-op.
- `failed` : transition gardee `pending -> failed` ; ne touche jamais `raised_minor`. -> `200`.
- depositRef inconnu -> `404` (pas de fuite d'etat au-dela de l'existence).

**`POST /admin/projects/:id/cancel`** (requireAdmin) : annule un projet `collecting`. Sous le verrou projet : passer `collecting -> cancelled`. Puis, hors verrou, rembourser chaque investissement `pending`/`escrowed` (section 7). Projet non `collecting` (y compris deja `cancelled`) -> `409 invalid_state`. Les remboursements par investissement restent idempotents quoi qu'il arrive (transitions gardees).

**`GET /me/investments`** (existant #4) : ajouter le champ `status` de l'investissement a la projection (l'investisseur voit pending/escrowed/released/refunded/failed). Toujours pas de PII projet.

---

## 7. Execution liberation / remboursement (hors verrou)

Meme principe que le payout Foundation : pas d'I/O reseau sous le verrou projet. La transition d'etat du projet se fait sous verrou ; les mouvements par investissement se font ensuite, en transactions courtes idempotentes, sures au retry.

**Liberation (auto, a l'objectif).** Le reglement qui atteint l'objectif passe `project -> funded` dans la transaction verrouillee, puis une routine de liberation itere les investissements `escrowed` de ce projet, chacun dans sa propre transaction courte : `provider.releaseEscrow` (cle = `release:<investmentId>`) -> crediter le wallet du porteur (entree `disbursement`, reference = investmentId) -> transition gardee `escrowed -> released` (+`resolution_ref`, `resolved_at`). Un crash en cours reprend sans double credit (garde d'etat). Mock : synchrone en ligne.

**Remboursement (annulation admin).** Apres `collecting -> cancelled` sous verrou, une routine itere les investissements `pending`/`escrowed` du projet, chacun en transaction courte : wallet-source -> entree `refund` positive (reference = investmentId) ; payment-source -> `provider.refundEscrow` (cle = `refund:<investmentId>`) ; decrementer `raised_minor` du montant ; transition gardee vers `refunded` (+`resolution_ref`, `resolved_at`). Un `pending` (depot jamais regle) est rembourse cote source : wallet credit si wallet, sinon refund provider (no-op cote argent si rien n'a ete preleve, mais l'appel idempotent est sur). Idempotent.

Note : pour le mock, tout est synchrone et lit comme un seul flux ; la structure (transactions courtes hors verrou, gardes d'etat, cles d'idempotence) est ce dont le partenaire reel a besoin.

---

## 8. Securite / integrite

- **accountId** toujours de la session (`req.accountId`) pour invest et `/me/investments` ; le webhook n'agit que via `depositRef`, jamais un accountId du body.
- **Webhook** verifie par secret partage (`ESCROW_WEBHOOK_SECRET`, config-driven, defaut vide -> rejet en prod ; les tests fournissent le secret) ; idempotent ; ne fuite pas d'etat au-dela de l'existence du depot.
- **Gate KYC** conservee a l'invest (`account.kyc_status == "verified"`, serveur).
- **Anti-surfinancement** : verrou `FOR UPDATE` projet + relecture du reste au reglement + `CHECK` DB ; l'increment au reglement ne change pas l'invariant.
- **Anti double-mouvement** : transitions gardees (`WHERE status = <attendu>`) + cles d'idempotence deterministes ; un webhook rejoue, un retry, un double callback sont des no-op.
- **Pas d'I/O reseau sous verrou** : liberation/remboursement hors de la transaction verrouillee, en pas idempotents.
- **Liberation vers le porteur** = credit wallet (`disbursement`), le porteur retire via le withdraw wallet existant (wallet-first). Aucune PII/champ interne fuite.
- Montants entiers ; validations strictes ; `source`/`method`/`status` webhook valides.

---

## 9. Reutilisation

`PaymentProvider`/`MockPaymentProvider` de #4 sont etendus (interface superset, meme injection) : `initiateDeposit` **remplace** `collectFunds` ; ajout de `releaseEscrow` + `refundEscrow` ; **`payout` est CONSERVE** (le retrait wallet Foundation s'en sert, distinct de la liberation escrow). La liberation credite le wallet du porteur en interne ; le porteur retire ensuite via le `withdraw` existant (qui appelle `payout`). service wallet (getBalance, insertion d'entree sous verrou, patron overdraw) ; verrou `FOR UPDATE` projet + `CHECK` DB de #4 ; `requireAuth`/`requireAdmin` ; enveloppe d'erreur + handler ; `buildTestApp` (mock escrow injecte, secret webhook de test) ; projections publiques Projets.

---

## 10. Tests

Fake escrow (`MockEscrowProvider` : instant-settle par defaut, mode `pending` pilotable) + `withTestDb`/`buildTestApp`.
- **Chemin instant (mock settled)** : invest payment -> `escrowed` + `raised` avance ; invest wallet -> `escrowed` + entree `reinvestment` negative.
- **Chemin async** : mock en mode `pending` -> invest renvoie `status=pending`, `raised` inchange ; `POST /escrow/settlement` `settled` -> `escrowed` + `raised++` ; **webhook rejoue** (deux fois settled) -> un seul increment (idempotence prouvee) ; `settled` sur un depot deja regle -> no-op.
- **Reglement failed** : `POST /escrow/settlement` `failed` -> investment `failed`, `raised` inchange.
- **Webhook non signe / mauvais secret** -> `401` ; depositRef inconnu -> `404`.
- **Liberation** : une sequence de reglements qui atteint pile l'objectif -> `projectStatus=funded`, chaque investment `released`, wallet du porteur credite du total (entrees `disbursement`), un invest suivant -> `409` (plus `collecting`).
- **Remboursement (annulation admin)** : projet `collecting` avec un mix wallet/payment escrowed + un `pending` -> `POST /admin/projects/:id/cancel` -> projet `cancelled`, chaque investment `refunded`, wallet-source credite (`refund`), payment-source refund provider appele, `raised` decremente ; **re-annulation** -> no-op/`409` (idempotence) ; non-admin -> `403` ; projet non `collecting` -> `409`.
- **`GET /me/investments`** expose `status`.
- **Concurrence** : deux reglements concurrents qui ensemble atteindraient l'objectif -> serialises par le verrou `FOR UPDATE`, un seul declenche `funded`, jamais de surfinancement (patron #4 ; test de course reel a deux transactions).

---

## 11. Questions ouvertes / defauts

1. **Re-annulation d'un projet deja `cancelled`** : ruling preflight -> `409 invalid_state` (coherent avec les autres transitions d'etat). Les remboursements par investissement restent idempotents quoi qu'il arrive.
2. **Depot `pending` au moment de l'annulation** : rembourse cote source ; pour payment-source, `refundEscrow` est appele meme si le depot n'etait pas encore regle (le partenaire reel traitera un refund sur un depot non capture comme une annulation ; le mock est un no-op sur l'argent mais marque l'etat). Defaut : acceptable, idempotent.
3. **`failed` vs `payment_failed`** : `payment_failed` (402) = refus synchrone a l'initiation (aucune ligne). `failed` (etat terminal) = depot accepte en `pending` puis decline via webhook. Deux cas distincts, deux traitements. Defaut : correct.
4. **Ordre des cles d'idempotence deterministes** : `deposit:<id>` / `release:<id>` / `refund:<id>` ; recalculables, non stockees. Suffisant tant qu'une operation par investissement et par type. Defaut : oui.
5. **Remboursement decline / wallet investisseur absent au moment de l'annulation** (differe partenaire reel) : si `refundEscrow` renvoie `ok:false` ou leve une exception (ou si le wallet de l'investisseur est introuvable pour un remboursement wallet-source), la transaction du remboursement de cet investissement s'annule avant la garde, laissant l'investissement `pending`/`escrowed` (donc encore remboursable) mais sans declencheur #5 pour le rejouer : le projet est deja `cancelled` et la re-annulation renvoie `409` (Q11.1). C'est une asymetrie assumee avec la liberation (rendue reprenable en #5 car son declencheur, le webhook, est deja rejoue). Le mock `refundEscrow` renvoie toujours `ok:true`, donc ce chemin est du code mort en #5 (comme le reglement tardif). La reprise = une action admin distincte, differee a l'integration du partenaire reel ; l'etat garde reste sur et rejouable quand cette action sera construite. Note observabilite : le chemin de decline est silencieux (pas de `console.error`), comme celui de la liberation ; a instrumenter avec le partenaire reel.
