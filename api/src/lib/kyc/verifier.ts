// A KycVerifier is handed a freshly created submission so an external (or
// manual) review workflow can pick it up. The service layer does NOT depend on
// this — the Task-5 HTTP route calls app.verifier.submitForReview(...) after a
// successful createSubmission.
export interface KycVerifier {
  submitForReview(submissionId: string): Promise<void>;
}

// Manual review: submissions sit in `pending` until a human admin acts on them,
// so there is nothing to dispatch here.
export class ManualVerifier implements KycVerifier {
  async submitForReview(_submissionId: string): Promise<void> {
    // no-op
  }
}
