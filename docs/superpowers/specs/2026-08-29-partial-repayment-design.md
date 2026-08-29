# KPITAL Backend, sous-systeme 8 : Remboursement partiel et anticipe

> Document de conception (spec). Statut : brouillon a relire.
> Date : 2026-08-29. Se greffe sur Foundation + KYC + Projets + Investissement (#4) + Escrow (#5) + Remboursement (#6) + Collections (#7), tous merges dans `main`.

---

## 1. Objectif et perimetre

Permettre au porteur de rembourser **partiellement** une tranche (verser moins que son montant) et **par anticipation** (verser plus, qui deborde en cascade sur les tranches suivantes), la ou #6 imposait le tout-ou-rien tranche par tranche. Tout l'argent reste **mocke** derriere `PaymentProvider` (couture two-phase de #6/#7), pret pour un partenaire reel.

Decisions de cadrage (validees) :
- **Partiel** : chaque tranche gagne un `paid_minor` (cumul recu) ; `paid` quand `paid_minor == amount_minor`.
- **Anticipe** : un versement s'impute en **cascade** sur les tranches non soldees (ordre `seq`), plafonne au restant du projet (pas de sur-paiement).
- **Pas de remise anticipee** : le total du est fixe (`raised * (1+roiPct)`), payer d'avance ne recalcule aucun interet (meme total, plus tot).
- **Interaction #7** : une tranche partiellement payee mais non soldee reste **delinquante** tant que `paid_minor < amount_minor`.
- Un **versement** (`repayment_payment`) est l'unite de collecte two-phase ; le webhook resout par la ref du versement (pas de la tranche).
- #8 **remplace** le flux `/repay` de #6 (montant libre + cascade) et **touche du code #6/#7 gele** proprement (distribution, orchestration, sweep), avec re-tests.

**Hors perimetre (section 11, conception suivante) :** remise/actualisation pour paiement anticipe ; caution/defaut reel (#7 §11) ; penalite non-nulle ; integration provider reel (initiateRepayment hors verrou, orphaned-payment reconciliation). Ce ne sont PAS des defauts de #8.

---

## 2. Decisions (issues du cadrage)

| Decision | Choix |
|---|---|
| Partiel | `repayment_installment.paid_minor` (cumul) ; `paid` a l'egalite avec `amount_minor` |
| Anticipe | cascade sur les tranches non-`paid` (ordre `seq`), plafonne au restant projet |
| Sur-paiement | interdit : `amount > restant` -> `409 exceeds_remaining` (+`remainingMinor`) sauf `confirmCapToRemaining` -> plafonne ; montant plafonne `<= 0` -> `409` |
| Remise anticipee | **aucune** (total fixe) |
| Unite de collecte | **`repayment_payment`** (two-phase), un versement = une collecte provider = N portions de tranches |
| Concurrence | **un seul versement `pending` par projet a la fois** (strict-sequentiel au niveau versement) ; un `/repay` avec un versement pending en vol -> `409 invalid_state` |
| Reglement (cascade) | **UNE transaction atomique** sous verrou projet : allocation persistee, toutes les portions + distributions + credits + statut versement en un tout-ou-rien |
| Idempotence reglement | garde `payment.status` (`settled` -> no-op) + atomicite ; `UNIQUE(payment_id, installment_id)` sur `repayment_application` = backstop + invariant de conservation |
| Distribution | reutilise la math pro-rata #6 (extraite en `distributePortion`), byte-identique, sur le montant de la **portion** |
| #7 delinquance | **`paid_minor < amount_minor` AND `due_at < cutoff`** (subsume le partiel ; remplace le predicat status-based de #7) |
| Backstops DB | `CHECK (paid_minor >= 0 AND paid_minor <= amount_minor)` ; partial unique `repayment_payment(ref) WHERE ref IS NOT NULL` |

FCFA entier ; « maintenant » = `new Date()` serveur ; tests sement `due_at`/`paid_minor`.

---

## 3. Modele : versement, imputation cascade, distribution

**En #6**, une tranche portait `repayment_ref` + statut binaire ; on payait une tranche entiere. **En #8**, un versement (`repayment_payment`) est l'unite de collecte, et une tranche accumule `paid_minor`.

**Imputation en cascade (au reglement).** Un versement de montant `A` (deja plafonne au restant a l'initiation) s'impute dans l'ordre `seq` sur les tranches non-`paid`, en UNE transaction atomique sous verrou projet :
```
reste = A
pour chaque tranche non-'paid' (ORDER BY seq) tant que reste > 0:
    portion = min(reste, tranche.amount_minor - tranche.paid_minor)
    inserer repayment_application(payment_id, installment_id, amount_minor = portion)
    distributePortion(applicationId, installmentId, portion)   # pro-rata #6, meme txn
    tranche.paid_minor += portion ; si == amount_minor -> status='paid'
    reste -= portion
garde payment 'pending' -> 'settled' (+settled_at)
si toutes les tranches 'paid' -> projet 'closed' (depuis repaying OU defaulted, comme #7)
sinon auto-lift #7 (voir section 8)
```

**Invariants de conservation (nommes, le crux monetaire) :**
- `Σ application.amount_minor pour un payment == payment.amount_minor` (le versement est entierement impute, jamais plus, jamais moins ; la cascade s'arrete quand `reste == 0`, et `A <= restant` garantit qu'on ne deborde pas l'echeancier).
- `installment.paid_minor == Σ application.amount_minor pour cette tranche` (backstop `CHECK paid_minor <= amount_minor`).
- Par portion : `Σ distribution == portion` exact (math #6 : floor + plus fort reste).

**Idempotence + reprise (sans le bug de recalcul).** L'allocation est **decidee une fois et persistee** dans `repayment_application`, jamais recalculee depuis `paid_minor` mutable. Comme tout le reglement est **une seule transaction atomique** : soit tout commit (versement `settled`, applications + distributions + `paid_minor` coherents), soit rien (crash -> rollback total, aucun etat partiel). Un rejeu (webhook renvoye, re-appel) voit `payment.status == 'settled'` en entree et no-op integralement. C'est plus simple et plus sur que le patron per-investisseur de #6 : pas d'etat partiel a reprendre, donc pas de sur-application possible. (Contre-exemple evite : recalculer `reste = A` sur l'ensemble non-`paid` apres un crash mi-cascade sur-applique ; ici l'atomicite l'interdit.)

Note volume : un payoff 12 tranches x 50 investisseurs ~ 600 inserts en une transaction (grand livre interne, aucun I/O reseau au reglement) -- acceptable.

---

## 4. Distribution : extraction de la math #6 (gele -> reutilise)

La primitive pro-rata verifiee par deux revues opus (#4/#6) est conservee **byte-identique** et extraite :
```
distributePortion(tx, { applicationId, installmentId, amountMinor }): void
```
Ensemble investisseurs = investissements `released` du projet (`Σ p_i == R = raised_minor`) ; `share_i = floor(amountMinor * p_i / R)` en BigInt ; reste distribue par plus fort reste, departage `investment.id` ASC ; `Σ share_i == amountMinor` exact. Insere `repayment_distribution(application_id, installment_id, investment_id, amount_minor = share_i)` + credit wallet `repayment` (meme txn). Zero-share -> aucune ligne.

**Ce qui est retire de #6 (orchestration seulement, pas la math) :** `settleRepayment(installmentId)`, le `/repay` per-tranche two-phase, la resolution webhook par ref de tranche, `repayKey(installmentId)`. Remplaces par les equivalents bases sur le versement (section 6). La math de distribution, elle, ne change pas.

---

## 5. Modele de donnees (migration 0017, additive)

**repayment_installment** (existant #6) :
- ajouter `paid_minor` bigint not null defaut 0.
- `CHECK (paid_minor >= 0 AND paid_minor <= amount_minor)`.
- `repayment_ref` (#6) reste en place mais **inutilise** par le flux #8 (Postgres : on ne retire pas la colonne). Le statut `pending` de tranche devient **vestigial** (le two-phase est au niveau versement) ; documente, non retire de l'enum.

**repayment_payment** (nouvelle) :
- `id` uuid pk ; `project_id` fk ; `amount_minor` bigint ; `ref` text null ; `status` enum `repayment_payment_status` (`pending`|`settled`|`failed`) defaut `pending` ; `settled_at` timestamptz null ; `created_at` timestamptz.
- partial unique `repayment_payment_ref_unique ON (ref) WHERE ref IS NOT NULL` (le webhook resout par `ref` ; meme argument que #6/#7).

**repayment_application** (nouvelle) :
- `id` uuid pk ; `payment_id` fk -> repayment_payment ; `installment_id` fk -> repayment_installment ; `amount_minor` bigint ; `created_at`.
- **`UNIQUE(payment_id, installment_id)`** (une portion par (versement, tranche) ; backstop d'idempotence + invariant de conservation).

**repayment_distribution** (existant #6, MODIFIE) :
- ajouter `application_id` uuid fk -> repayment_application (not null pour les nouvelles lignes).
- **retirer** l'ancienne unique `(installment_id, investment_id)` (une tranche recoit desormais plusieurs portions -> plusieurs distributions) ; la remplacer par rien de contraignant : avec le reglement en une transaction atomique, la garde `payment.status` couvre l'exactly-once, donc `application_id` est une simple FK. (`installment_id` reste pour `repaidMinor`/requetes.) La raison est ecrite ici pour qu'un reviewer ne lise pas la suppression de l'ancienne unique comme un affaiblissement.

Reutilise `entry_type` (`repayment`), `project_status`, `notification_pref`.

---

## 6. Endpoints et flux

Enveloppe d'erreur uniforme `{ error: { code, message, details? } }`.

**`POST /projects/:id/repay { amountMinor, confirmCapToRemaining? }`** (auth ; owner ; projet `repaying` OU `defaulted`) : **remplace** le flux #6.
1. Sous verrou projet : si un `repayment_payment` `pending` existe pour le projet -> `409 invalid_state` (collecte en vol, strict-sequentiel au niveau versement). Sinon calculer `restant = Σ(amount_minor - paid_minor)` sur les tranches non-`paid`.
2. `amountMinor` entier > 0. Si `> restant` : sans `confirmCapToRemaining` -> `409 exceeds_remaining` (+`details.remainingMinor`) ; sinon plafonner `amountMinor = restant`. Si le montant (plafonne) `<= 0` -> `409 invalid_state` (rien a payer ; un projet solde est deja `closed`).
3. Inserer `repayment_payment(status='pending', amount_minor)`. `initiateRepayment({ payerAccountId: owner, amountMinor, idempotencyKey: repayKey(paymentId) })`. `!ok` -> `PaymentFailedError` (rollback, `402 payment_failed`, aucune ligne payment). Sinon `ref = res.ref` ; commit.
4. Hors verrou : si `res.status === 'settled'` (mock) -> `settlePayment(paymentId)` (cascade, section 3). Relire l'etat.
5. Reponse `201 { paymentId, amountMinor, status: 'pending'|'settled', appliedMinor, projectStatus }` (`appliedMinor` = montant impute au reglement, 0 si encore pending ; lu apres reglement).
- Codes : `invalid_state` 409, `exceeds_remaining` 409 (+remainingMinor), `payment_failed` 402, non-owner 403, non-UUID 404.

**`POST /escrow/repayment { repaymentRef, status }`** (webhook secret, comme #6/#7) : **revise** pour resoudre `repayment_payment` par `ref`. `settled` -> `settlePayment(paymentId)` ; `failed` -> garde `payment pending -> failed` (rien impute) ; ref inconnu -> `404` ; secret absent/mauvais -> `401`. Idempotent (garde payment status).

**`GET /projects/:id/repayment-schedule`** (owner, existant #6/#7) : par tranche, exposer `paidMinor` et `remainingMinor` (= `amount_minor - paid_minor`) en plus de `overdue`/`remindedAt` (#7) et des champs existants. Pas de PII investisseur.

**`GET /me/investments`** : `repaidMinor` inchange (somme des `repayment_distribution` de l'investisseur ; marche avec le nouveau modele multi-portions).

---

## 7. Interaction #6 / #7 (code gele touche)

- **#6** : `settleRepayment` (orchestration) retire ; sa math -> `distributePortion`. Le `/repay` per-tranche et la resolution webhook par ref-de-tranche -> remplaces (section 4/6). Les tests #6 de distribution sont re-pointes sur `distributePortion` (math inchangee) ; les tests d'orchestration #6 (`/repay` per-tranche, webhook par tranche) sont reecrits pour le flux versement.
- **#7 delinquance** : le sweep (`runRepaymentSweep`) et l'auto-lift `/repay` utilisent desormais **`paid_minor < amount_minor` AND `due_at < cutoff`** (au lieu de `status IN (due,pending)`). Predicats a ajuster : relance (tranche non soldee overdue), defaut (tranche non soldee grace-exceeded), reprise/auto-lift (plus aucune tranche non soldee grace-exceeded). Une relance in-flight n'est PAS supprimee par un versement `pending` (l'argent n'a pas atterri ; le sweep est purement pilote par `paid_minor`). La stickiness admin (#7) inchangee.
- **Close-from-defaulted** (#7) : conserve ; un versement qui solde toutes les tranches ferme le projet depuis `repaying` ou `defaulted`.

---

## 8. Securite / integrite

- `accountId` de la session ; `/repay` owner-only ; webhook via `ref` seulement, secret-gated.
- **Conservation** (section 3) : `Σ application == payment.amount` ; `paid_minor` borne par `CHECK` ; `Σ distribution == portion`. Pas de sur-paiement (plafond au restant), pas de sur-application (atomicite), pas de double-credit (garde `payment.status` + une txn).
- **Un versement pending par projet** : pas de course de capacite entre deux versements concurrents (strict-sequentiel), donc pas besoin de reservation de capacite ; deux `/repay` concurrents -> l'un insere le payment pending, l'autre voit `pending` -> 409, serialises par le verrou projet.
- **Auto-lift #7** : garde standalone, ne roule jamais le reglement en arriere.
- Montants entiers ; validations strictes ; aucune PII/champ interne fuite ; credits investisseurs = wallet `repayment`.
- Pas d'I/O reseau sous verrou au reglement (cascade = grand livre interne pur ; l'appel provider est a l'initiation, comme #6).

---

## 9. Reutilisation

Math pro-rata #6 (extraite `distributePortion`, byte-identique) ; `PaymentProvider.initiateRepayment` + webhook secret #6/#7 ; verrou projet + patron de garde d'etat + cles d'idempotence deterministes ; `requireAuth` + owner-check ; sweep/auto-lift #7 (predicats ajustes) ; `buildTestApp` ; enveloppe d'erreur.

---

## 10. Tests

Fake payments (`initiateRepayment` settled/pending pilotable) + `withTestDb`/`buildTestApp`.
- **Partiel** : `/repay` d'un montant < restant de la 1re tranche -> tranche `paid_minor` avance, pas `paid`, versement distribue pro-rata (somme = versement) ; un 2e versement solde la tranche -> `paid`.
- **Cascade anticipee** : `/repay` d'un montant couvrant 2.5 tranches -> tranches 1-2 `paid`, tranche 3 partielle ; `Σ application == versement` ; chaque portion distribuee, `Σ distribution == portion`.
- **Payoff** : `/repay` du restant total -> toutes tranches `paid`, projet `closed`, `appliedMinor == restant`.
- **Plafond** : `/repay` > restant sans confirm -> `409 exceeds_remaining` (+remaining) ; avec `confirmCapToRemaining` -> plafonne au restant + solde.
- **Async two-phase** : mock `pending` -> `/repay` renvoie `status=pending`, rien impute ; webhook `settled` -> cascade ; **webhook rejoue** -> impute une seule fois (idempotence, garde payment status) ; un 2e `/repay` pendant un pending -> `409`.
- **Reglement failed** : webhook `failed` -> versement `failed`, rien impute, `paid_minor` inchange.
- **Idempotence/atomicite** : re-`settlePayment` d'un versement `settled` -> aucune nouvelle application/distribution/credit ; conservation `Σ application == amount`.
- **Refus provider** : `initiateRepayment {ok:false}` -> `402`, aucune ligne payment.
- **#7 partiel-delinquant** : une tranche partiellement payee mais non soldee, overdue past grace -> sweep la traite comme delinquante (relance / defaut) ; une fois soldee par un versement -> reprise/auto-lift.
- **Reads** : `paidMinor` + `remainingMinor` par tranche ; `repaidMinor` sur `/me/investments` somme les distributions multi-portions.
- **Conservation pro-rata** : parts inegales, portion impaire -> floors + plus fort reste, somme = portion exacte, departage deterministe (repointe des tests math #6).

---

## 11. Questions ouvertes / defauts, A TRAITER A LA CONCEPTION SUIVANTE

1. **Remise / actualisation anticipee** : #8 garde le total fixe (aucune ristourne d'interet pour paiement anticipe). Un modele avec rabais d'interet est une conception distincte. -> suivante.
2. **Reports #7** : caution/garantie reelle au defaut, recouvrement, penalite non-nulle (collecte + distribution), cadence de relance fine, scheduler reel. -> suivante.
3. **Reports #5/#6** : integration provider reel (initiateRepayment/deposit hors verrou, orphaned-payment/deposit reconciliation, declined-refund resume, late-settlement apres closed). -> integration partenaire reel.
4. **Un seul versement pending par projet** : simplifie la concurrence en #8. Autoriser plusieurs versements concurrents (avec reservation de capacite type #4) est un raffinement si le besoin apparait. -> suivante si besoin.
5. **Derive d'arrondi par investisseur** (heritee #6) : conservation exacte par portion ; le total par investisseur peut derive de quelques unites du theorique. -> suivante si un lissage est souhaite.
