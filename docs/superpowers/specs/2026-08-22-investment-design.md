# KPITAL Backend, sous-système 4 : Intention d'investissement

> Document de conception (spec). Statut : brouillon à relire.
> Date : 2026-08-22. Se greffe sur Foundation + KYC + Projets (mergés dans `main`).

---

## 1. Objectif et périmètre

Permettre à un investisseur (KYC vérifié) d'engager un ticket sur un projet en phase de collecte (`collecting`), avec le mouvement d'argent **mocké** derrière l'interface `PaymentProvider` (le séquestre réel est le #5). Enregistrer l'investissement, faire avancer la collecte de façon **concurrente-sûre**, et passer le projet en `funded` quand l'objectif est atteint (jamais de surfinancement).

**Dans le périmètre :**
- `POST /projects/:id/invest` : investir un montant, source **argent frais (mock)** ou **solde wallet (réinvestissement)**.
- Gate **KYC `verified`** ; ticket minimum ; anti-surfinancement avec confirmation du reste.
- Progression de collecte (`raised_minor` dénormalisé) + auto-`funded` à l'objectif, sous verrou (pas de course).
- `GET /me/investments` (alimente le dashboard investisseur) ; `raisedMinor`/progression exposés sur la surface financement + la fiche.
- Ajout de `collectFunds` à l'interface `PaymentProvider` (+ impl mock).

**Hors périmètre (référencé, #5) :**
- Paiement / séquestre **réel** (partenaire agréé) ; états de séquestre (pending/escrowed/released) ; remboursement (funded→repaying→closed + crédits wallet des remboursements) ; remboursement/annulation si la collecte échoue.

---

## 2. Décisions (issues du cadrage)

| Décision | Choix |
|---|---|
| Éligibilité | Projet en `collecting` **et** compte `kyc_status="verified"` (sinon 403) |
| Ticket minimum | **10 000 FCFA** (`MIN_TICKET_MINOR`) |
| Surfinancement | **Interdit.** Si montant > reste : `409 exceeds_remaining` (+ `remainingMinor`) tant que `confirmCapToRemaining` absent ; si confirmé → **plafonner au reste** et investir |
| Fin de collecte | **Auto-`funded`** quand `raised == target` ; plus aucun investissement accepté |
| Sources | **payment** (mock `collectFunds`) **ou** **wallet** (écriture `reinvestment` au grand livre, contrôle de solde) |
| Concurrence | Tout l'investissement dans **une transaction** avec **`FOR UPDATE` sur la ligne `project`** ; le reste est relu sous verrou au débit |
| Progression | `project.raised_minor` **dénormalisé**, maj atomique dans la même transaction |

FCFA n'a pas de sous-unité : les montants « minor » sont des entiers FCFA (cohérent avec `target_minor`).

---

## 3. Flux d'investissement (concurrence-sûr)

```
POST /projects/:id/invest { amountMinor, source, method?, confirmCapToRemaining? }
  guard: requireAuth ; account.kyc_status == "verified" (else 403 kyc_required)
  db.transaction:
    lock project row (SELECT ... FOR UPDATE)
    if project.status != "collecting" -> 409 invalid_state
    remaining = target_minor - raised_minor
    if amountMinor < MIN_TICKET_MINOR -> 400 below_min_ticket
    if amountMinor > remaining:
        if !confirmCapToRemaining -> 409 exceeds_remaining { remainingMinor: remaining }
        else amountMinor = remaining            # plafonné au reste, confirmé
    # collect the funds
    if source == "wallet":
        lock wallet row (FOR UPDATE) ; if balance < amountMinor -> 400 insufficient_funds
        insert wallet_entry(type="reinvestment", amount_minor = -amountMinor, reference = investmentId)
    else (source == "payment"):
        res = payments.collectFunds({ accountId, amountMinor, method }) ; if !res.ok -> 402 payment_failed
        paymentRef = res.ref
    insert investment(project_id, investor_account_id, amount_minor, source, payment_ref, status="confirmed")
    raised_minor += amountMinor
    if raised_minor == target_minor: project.status = "funded"
  -> 201 { investmentId, amountMinor, raisedMinor, projectStatus }
```

Le verrou `FOR UPDATE` sur la ligne projet sérialise les investissements concurrents : impossible que deux tickets passent chacun le contrôle du reste et dépassent l'objectif. Le solde wallet est verrouillé de la même façon (patron du retrait anti-découvert). Le mock `collectFunds` est synchrone ; le vrai provider (#5) déplacera l'appel réseau hors du verrou (motif noté).

---

## 4. Modèle de données

**investment**
- `id` uuid pk
- `project_id` uuid fk → project
- `investor_account_id` uuid fk → account
- `amount_minor` bigint (montant investi, entier FCFA)
- `source` enum `investment_source` : `payment` | `wallet`
- `payment_ref` text null (réf mock pour `payment` ; l'entrée wallet référence l'id d'investissement pour `wallet`)
- `status` enum `investment_status` : `confirmed` (les états séquestre/refund viennent au #5)
- `created_at` timestamptz

**project** (existant) : ajouter `raised_minor` bigint défaut 0 (dénormalisé, maj atomique). `funded` déclenché quand `raised_minor == target_minor`.

**wallet_entry** (existant) : réutilise le type `reinvestment` (déjà dans l'enum) pour la source wallet ; entrée négative.

---

## 5. Endpoints

- `POST /projects/:id/invest` (auth ; KYC `verified`) : body `{ amountMinor (int > 0), source: "payment"|"wallet", method? (pour payment), confirmCapToRemaining? (bool) }`. Comportement §3. Réponses : `201 { investmentId, amountMinor, raisedMinor, projectStatus }` ; `403 kyc_required` ; `409 invalid_state` (projet non `collecting`) ; `400 below_min_ticket` ; `409 exceeds_remaining` (+ `details.remainingMinor`) ; `400 insufficient_funds` (wallet) ; `402 payment_failed` (mock échec).
- `GET /me/investments` (auth) : la liste des investissements du caller, avec un résumé projet (titre, catégorie, statut, roi_pct) + `amountMinor`, `source`, `createdAt`. Alimente le dashboard.
- **Progression publique** : ajouter `raisedMinor` (et donc la progression = `raised/target`) à la projection **financement** (`FUNDING_PROJECT_COLUMNS`) et à la **fiche** (`GET /projects/:id`) pour les projets `collecting`/`funded`. (Toujours pas d'`upvoteCount`/`followCount` sur le financement.)

Enveloppe d'erreur uniforme `{ error: { code, message, details? } }`.

---

## 6. Sécurité / intégrité

- **Gate KYC** : investir exige `account.kyc_status == "verified"` (vérifié serveur, jamais depuis le body).
- **accountId** de la session (`req.accountId`), jamais du body. On investit pour soi.
- **Anti-surfinancement** garanti par le verrou `FOR UPDATE` sur la ligne projet + relecture du reste au débit ; le plafonnage n'a lieu que sur `confirmCapToRemaining` explicite (pas de prélèvement surprise).
- **Wallet** : solde vérifié sous verrou (`FOR UPDATE`), entrée `reinvestment` négative dans la même transaction — pas de découvert, pas de double-dépense (patron du retrait).
- **Atomicité** : collecte des fonds (mock) + insertion investment + incrément `raised_minor` + éventuel passage `funded`, tout dans une seule transaction ; un échec annule tout (aucun investment sans fonds, aucun fonds sans investment).
- Montants entiers ; validations strictes ; `source`/`method` validés ; aucune PII/champ interne fuité.

---

## 7. Réutilisation

`PaymentProvider`/`MockPaymentProvider` (on ajoute `collectFunds`, comme `payout`) ; service wallet (`getBalance`, insertion d'entrée sous verrou) ; `requireAuth` ; checks d'état projet + verrou `FOR UPDATE` (patron des tâches Projets/Wallet) ; enveloppe d'erreur + handler ; `buildTestApp` (mock payments + fake storage) ; projections publiques Projets.

---

## 8. Tests

- Fake payments (mock `collectFunds` ok/échec) + `withTestDb`/`buildTestApp`.
- Parcours : investir en `payment` sur un projet `collecting` (KYC verified) → 201, `raised_minor` avance ; investir en `wallet` → entrée `reinvestment` négative + solde diminué ; **gate** : compte non-`verified` → 403 ; projet non-`collecting` → 409 ; montant < min → 400 ; **surfinancement** : montant > reste sans confirm → 409 `exceeds_remaining` (+ remaining), avec `confirmCapToRemaining` → plafonné au reste + 201 ; **auto-funded** : un ticket qui atteint pile l'objectif → `projectStatus="funded"` et un investissement suivant → 409 (plus `collecting`) ; wallet insuffisant → 400 ; `GET /me/investments` renvoie mes investissements ; progression `raisedMinor` visible sur `/projects/funding` et la fiche.
- (La sérialisation stricte sous concurrence réelle n'est pas testable via le harness savepoint — vérifiée par lecture + le patron `FOR UPDATE` déjà éprouvé pour le retrait.)

---

## 9. Questions ouvertes / défauts

1. **`funded` exact** : déclenché quand `raised_minor == target_minor` (le plafonnage garantit qu'on n'atteint jamais `>`). Défaut : oui, égalité stricte suffit car jamais de surfinancement.
2. **Un même investisseur, plusieurs tickets** : autorisé (plusieurs `investment` par (investisseur, projet)) tant que le projet est `collecting` et qu'il reste du disponible. Défaut : autorisé.
3. **`GET /me/investments`** : renvoie tous statuts ; pour l'instant seul `confirmed` existe (#5 ajoutera les états). Défaut : ok.
