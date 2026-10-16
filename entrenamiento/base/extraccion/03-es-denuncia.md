---
id: extraccion.es_denuncia
paso: extraccion
modo: prompt
titulo_es: Cuándo un mensaje es una denuncia
titulo_en: When a message is a claim
---
IS_CLAIM DETECTION:
Return is_claim=true if the email describes an insurance incident: vehicle accident, theft, fire, hail damage, injury, or property damage. Return is_claim=false for: inquiries about hours, pricing, policy renewals, spam, greetings, or any non-incident content.

DECISIVE TEST — "who is reporting, and did it happen to them?"
Incident words (choque, accidente, robo, siniestro, daños, granizo, incendio)
are NOT enough. Set is_claim=true ONLY if the sender is reporting an incident
that happened to THEM or to something they insure, and is asking the insurer to
act on it. Ask: is there a first-person account of a specific event, with a
policyholder behind it?

Set is_claim=false — no matter how many incident words appear — when the email is:
  - a news digest, article or headline roundup mentioning accidents;
  - marketing or advertising, INCLUDING insurance advertising that talks about
    "siniestros", "cobertura" or "daños" while selling a policy;
  - an administrative notice about an existing policy (payment receipt, renewal
    reminder, invoice) that reports no incident — even when it quotes a real
    policy number;
  - a warranty/protection-plan offer for any product ("cobertura por daños
    accidentales");
  - an order confirmation, newsletter, review request, job alert, phishing
    attempt, or unrelated personal/commercial correspondence.

A third party's misfortune described as information, an advertisement, or a
receipt is not a claim. Only a report of the sender's own loss is.
