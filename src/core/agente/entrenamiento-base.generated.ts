// Generado por scripts/empaquetar-entrenamiento.mjs (pnpm entrenamiento:empaquetar). No se edita a mano:
// el CI corre `node scripts/empaquetar-entrenamiento.mjs --comprobar` y falla si queda desactualizado.
// Sin imports a propósito: lo leen el servidor, el ensayo con tsx y la consola, y ninguno tiene los .md.

export type PasoDelAgente = "extraccion" | "decidir" | "redactar";
export type ModoDeSeccion = "prompt" | "sombra";
export type DecisionDeSombra = "gravedad" | "derivar" | "pedir" | "responder";
export type IdDeSeccion =
  | "extraccion.confianza"
  | "extraccion.gravedad"
  | "extraccion.es_denuncia"
  | "extraccion.ramo"
  | "extraccion.datos_por_ramo"
  | "extraccion.mecanica"
  | "extraccion.fraude"
  | "extraccion.documentacion"
  | "extraccion.gravedad_del_codigo"
  | "extraccion.derivar"
  | "decidir.criterios"
  | "decidir.consultar"
  | "decidir.pedir"
  | "decidir.responder"
  | "redactar.voz"
  | "redactar.pedir"
  | "redactar.acuse"
  | "redactar.canal_whatsapp"
  | "redactar.canal_mail"
  | "redactar.tono"
  | "redactar.recordatorio";

export interface SeccionDeEntrenamiento {
  readonly id: IdDeSeccion;
  readonly paso: PasoDelAgente;
  readonly modo: ModoDeSeccion;
  readonly decision?: DecisionDeSombra;
  readonly titulo: { readonly "es-AR": string; readonly "en-US": string };
  readonly ruta: string;
  readonly texto: string;
}

// `texto` es el cuerpo del .md tal cual, con LF y sin el salto de línea final.
export const ENTRENAMIENTO_BASE: readonly SeccionDeEntrenamiento[] = [
  {
    id: "extraccion.confianza",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Confianza de cada dato", "en-US": "Confidence of each field" },
    ruta: "entrenamiento/base/extraccion/01-confianza.md",
    texto: "CONFIDENCE THRESHOLDS:\n- High confidence (≥ 0.85): Clearly stated facts — include in extracted_fields\n- Medium confidence (0.60–0.85): Inferred, partially stated, or conflicting — include in fields_pending_confirmation\n- Low confidence (< 0.60): Uncertain or absent — include in missing_fields, NOT in extracted_fields\nDo NOT put clearly labeled facts in fields_pending_confirmation. For example,\n\"Nombre completo:\", \"Numero de poliza:\", \"DNI:\", \"Email:\", \"Telefono:\",\nand \"Tipo de siniestro:\" are high-confidence facts when their value is present.",
  },
  {
    id: "extraccion.gravedad",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Gravedad del siniestro", "en-US": "Claim severity" },
    ruta: "entrenamiento/base/extraccion/02-gravedad.md",
    texto: "SEVERITY CLASSIFICATION:\n- critical: muerte, fallecido, muerto, fallecimiento, incendio, explosión, robo a mano armada, amenaza con arma\n- high: ambulancia, hospitalizado, herido, lesiones, lesionado, policía, policia, urgencia, robo\n- medium: choque, colisión, colision, accidente, granizo, inundación\n- low: rayones, golpe leve, daño menor, raspón, abolladura leve, daño estético, sin heridos\nCONTEXT CUES that escalate to AT LEAST 'medium' (apply when no higher-severity\nkeyword has matched):\n- Multi-vehicle accident (two or more vehicles named with plates)\n- Named Argentine insurer present (Zurich, Galeno, Sancor, La Caja, Provincia,\n  Federación Patronal, Mercantil Andina, San Cristóbal, Allianz, etc.)\n- Explicit siniestro/póliza number present\n- Pending inspection, denuncia, or constancia of any kind\n- Multiple parties exchanging documentation\nUse the HIGHEST of: (keyword severity), (context-cue floor = 'medium').\nIf no signals found, use \"medium\" as default for claims.",
  },
  {
    id: "extraccion.es_denuncia",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Cuándo un mensaje es una denuncia", "en-US": "When a message is a claim" },
    ruta: "entrenamiento/base/extraccion/03-es-denuncia.md",
    texto: "IS_CLAIM DETECTION:\nReturn is_claim=true if the email describes an insurance incident: vehicle accident, theft, fire, hail damage, injury, or property damage. Return is_claim=false for: inquiries about hours, pricing, policy renewals, spam, greetings, or any non-incident content.\n\nDECISIVE TEST — \"who is reporting, and did it happen to them?\"\nIncident words (choque, accidente, robo, siniestro, daños, granizo, incendio)\nare NOT enough. Set is_claim=true ONLY if the sender is reporting an incident\nthat happened to THEM or to something they insure, and is asking the insurer to\nact on it. Ask: is there a first-person account of a specific event, with a\npolicyholder behind it?\n\nSet is_claim=false — no matter how many incident words appear — when the email is:\n  - a news digest, article or headline roundup mentioning accidents;\n  - marketing or advertising, INCLUDING insurance advertising that talks about\n    \"siniestros\", \"cobertura\" or \"daños\" while selling a policy;\n  - an administrative notice about an existing policy (payment receipt, renewal\n    reminder, invoice) that reports no incident — even when it quotes a real\n    policy number;\n  - a warranty/protection-plan offer for any product (\"cobertura por daños\n    accidentales\");\n  - an order confirmation, newsletter, review request, job alert, phishing\n    attempt, or unrelated personal/commercial correspondence.\n\nA third party's misfortune described as information, an advertisement, or a\nreceipt is not a claim. Only a report of the sender's own loss is.",
  },
  {
    id: "extraccion.ramo",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Ramo del siniestro", "en-US": "Claim type" },
    ruta: "entrenamiento/base/extraccion/04-ramo.md",
    texto: "  ⚠️ DECISIVE TEST FOR COLLISIONS (apply this BEFORE anything else when there is a crash/golpe/impacto):\n  Ask \"¿quién sufrió el daño que se está reclamando?\"\n    • \"Yo choqué y se dañó MI auto\" (the insured claims for their OWN vehicle/property) → choque\n    • \"Yo choqué y le dañé a UN TERCERO\" (the insured CAUSED damage to someone else — another\n      vehicle, a pedestrian/ciclista, a parked car, a wall/propiedad ajena — and that third party\n      is the damnificado who reclaims) → **rc** (responsabilidad civil), NOT choque.\n  Do not default collisions to choque. If a tercero damnificado is present and their loss is the\n  subject of the claim, it is rc even though a collision occurred. Examples that are rc, not choque:\n  golpe de puerta a un ciclista; chocar y abollar un auto estacionado; embestir un poste/pared\n  ajena; atropellar a un peatón causándole daños.\n\n  Then classify using these rules (evaluate in order; pick the FIRST that matches):\n  • art — a WORK accident or occupational illness of a WORKER reported as a workers' compensation claim\n    (ART, accidente laboral, enfermedad profesional, in itinere, empleador, lesión de un empleado), even\n    though it is also a bodily injury. NOT art, whatever the place or the hour: (1) damage to or theft of\n    the insured's own VEHICLE that merely happened at work or on the way to or from it (\"iba hacia el\n    trabajo\", \"en horario laboral\") — that is choque, robo, etc.; (2) a person who says there is no ART,\n    who works alone or is self-employed, or who is claiming under a personal accident policy — that is\n    accidente_personal.\n  • vida — a beneficiary or relative reports the DEATH or permanent disability of the insured PERSON\n    under a life policy (seguro de vida, beneficiario, fallecimiento del asegurado). A death in a vehicle\n    crash claimed on a vehicle policy is NOT vida.\n  • integral_comercio — damage or theft at a shop, business or office premises (local, comercio,\n    mercadería, vidriera), not a vehicle.\n  • consorcio — damage to the COMMON areas of a building (consorcio, administración, expensas, ascensor,\n    filtración en el edificio), not a private unit or a vehicle.\n  • accidente_personal — the claim is primarily about a PERSON's bodily injury\n    (lesiones, fractura, herido, internación, certificado médico), regardless of how it happened.\n  • rc (responsabilidad civil) — see the DECISIVE TEST above: damage the insured CAUSED TO A THIRD\n    PARTY, where covering that third party's loss / the insured's liability is the purpose. Signals:\n    a named damnificado (tercero), \"le ocasioné/causé daños a\", \"responsabilidad civil\", \"daños a\n    terceros\", door-ding to a parked car, hitting a pedestrian/cyclist or another vehicle where THE\n    OTHER PARTY's damage is the subject.\n  • cristales — damage limited to glass/cristales (parabrisas, luneta, ventanilla), no collision.\n  • robo_contenido — theft of belongings/contents FROM a vehicle (objetos, herramientas,\n    pertenencias), where the vehicle itself was NOT stolen. (robo = the whole vehicle was stolen.)\n  • granizo — hail damage. incendio — fire.\n  • choque — collision damaging the INSURED's OWN vehicle (no third-party claim — see DECISIVE TEST).\n  • robo — theft of the entire vehicle. other — anything that fits none of the above.",
  },
  {
    id: "extraccion.datos_por_ramo",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Datos que pide cada ramo", "en-US": "Data each claim type requires" },
    ruta: "entrenamiento/base/extraccion/05-datos-por-ramo.md",
    texto: "REQUIRED DATA BY CLAIM TYPE (add to fields[] only, with exactly these keys, even though the list above asks for English keys):\n- patente_vehiculo: the plate of the INSURED's vehicle, for choque, rc, robo, granizo, incendio, cristales and robo_contenido. Never the third party's plate.\n- provincia_siniestro: the Argentine province where it happened, for every claim type. When a city is clear, derive the province with confidence 0.90 (Bahía Blanca -> Buenos Aires). Never derive it from a street alone.\n- hora_siniestro: the time it happened (HH:MM, 24 h), for choque and rc. A time the person gives (\"a las 19\", \"19 hs\", \"a eso de las 19\") is a stated fact: confidence 0.90, never fields_pending_confirmation. Only a vague moment (\"a la tarde\") is medium.\n- hay_heridos (\"si\" or \"no\"), testigos, numero_denuncia and accident_location: ONLY for a tenant claim type that lists them in [data to extract]. hay_heridos only when the person said something about injuries. testigos: the name and phone of the witnesses the person gives; \"ninguno\" with confidence 0.90 when the person says there were none. numero_denuncia: the number of a police report or complaint the person says they already filed, copied exactly (never the policy number, never invented). accident_location: as in the field list above.\nNever add a vehicle-type field such as tipo_vehiculo: the plate already identifies the vehicle, and a model name (Gol, Corolla) is not something to confirm.\nWhen one of these is not stated: empty value, confidence 0, and list it in missing_fields.",
  },
  {
    id: "extraccion.mecanica",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Mecánica del choque", "en-US": "Collision mechanics" },
    ruta: "entrenamiento/base/extraccion/06-mecanica.md",
    texto: "COLLISION MECHANICS (mecanica):\nmecanica has nothing to do with claim_type and never changes it: a crash of a single vehicle (against a post, a wall, a tree, a curb) still gets its claim_type from the DECISIVE TEST and the rules above, and mecanica=null does not mean the claim type is unknown.\nFill mecanica only when two or more vehicles collided; otherwise mecanica=null. \"asegurado\" is the sender's vehicle, \"tercero\" is the other one.\nFill a field ONLY with what the person says literally; null for everything else. Never infer, never work out who had the right of way, and never say who is at fault.\n- maniobra_asegurado / maniobra_tercero: what each vehicle was doing when they collided: avanzaba_recto, giraba_izquierda, giraba_derecha, retrocedia, cambiaba_carril, estacionado, detenido, otra.\n- semaforo_asegurado / semaforo_tercero: the light each one faced: verde, amarillo, rojo, sin_semaforo (the text says there was no traffic light), no_dice (there was a light and the text does not say the color).\n- interseccion: true if they collided at a street crossing, false if the text clearly places it elsewhere (a straight road, a parked car), null if not said.\n- venia_por_la_derecha: true only if the text says the insured came from the third party's right; false only if it says the third party came from the insured's right; null otherwise. A street name or a direction is not enough.\n- embistio_de_atras: \"asegurado\" if the insured hit the other vehicle from behind, \"tercero\" if the third party hit the insured from behind, null otherwise.\n- excepcion_prioridad: true if the text mentions something that alters the right of way (a priority road, an emergency vehicle, a stop sign, a roundabout, the insured turning); false ONLY if the text explicitly says none of that applied (\"no había ningún cartel de pare\", \"los dos por calles comunes\"); null if not said. Silence about it is null, never false.\nThese values go ONLY into mecanica. Never copy them into fields[], extracted_fields, summary or suggested_reply.",
  },
  {
    id: "extraccion.fraude",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Señales de fraude", "en-US": "Fraud signals" },
    ruta: "entrenamiento/base/extraccion/07-fraude.md",
    texto: "FRAUD RISK ASSESSMENT:\nAnalyze the claim for inconsistencies and behavioral red flags. Set fraud_risk_level to:\n- \"high\"   — multiple strong inconsistencies: impossible timeline (claim filed before incident date), contradictory location details, damage description inconsistent with stated cause, claim filed within days of policy inception, multiple recent claims on same vehicle\n- \"medium\" — one clear inconsistency or suspicious pattern: vague damage description, missing key documentation for claim type, unusually precise damage amounts, incident location doesn't match vehicle registration area\n- \"low\"    — minor ambiguities: minor timeline gaps, incomplete information that could be innocent\n- \"none\"   — no anomalies detected; claim is internally consistent\n\nFor each inconsistency found, add an entry to fraud_indicators with:\n- type: one of \"timeline_inconsistency\", \"location_inconsistency\", \"damage_inconsistency\", \"documentation_gap\", \"repeat_claimant\", \"behavior_signal\", \"other\"\n- description: one sentence in Spanish describing the specific flag (max 150 chars)\n\nIMPORTANT: fraud assessment is advisory only — analysts make the final determination. Do not accuse; describe observations neutrally. If no fraud signals: fraud_risk_level=\"none\", fraud_indicators=[].",
  },
  {
    id: "extraccion.documentacion",
    paso: "extraccion",
    modo: "prompt",
    titulo: { "es-AR": "Documentación mencionada", "en-US": "Documentation mentioned" },
    ruta: "entrenamiento/base/extraccion/08-documentacion.md",
    texto: "DOCUMENTATION / ATTACHMENT SIGNALS TO MIRROR INTO fields[]:\n- fotos_danos: \"si\" when damage photos are listed as attached or clearly mentioned\n- licencia_conducir: \"si\" when a driver's license copy/photo is listed as attached or clearly mentioned\n- denuncia_policial: \"si\" when a police report/denuncia is listed as attached or clearly mentioned\n- police_report_number: report number if stated\n- parte_amistoso: \"si\" only when a friendly accident report is listed as attached or clearly mentioned\nThese document keys are not part of extracted_fields, but MUST be added to\nfields[] with confidence 0.85-0.95 when clearly present. Do not list a document\nas missing if it is in the attached/mentioned documentation block.",
  },
  {
    id: "extraccion.gravedad_del_codigo",
    paso: "extraccion",
    modo: "sombra",
    decision: "gravedad",
    titulo: { "es-AR": "Cómo fija la gravedad el código", "en-US": "How the code sets severity" },
    ruta: "entrenamiento/base/extraccion/90-gravedad-del-codigo.md",
    texto: "Así fija la gravedad el código de hoy. Se describe para poder comparar; no es una instrucción para el modelo.\n\nLa gravedad del caso es la más alta de dos lecturas: la de un léxico de palabras sobre el asunto y el cuerpo del mensaje, y la que dio el modelo. El léxico puede subirla, nunca bajarla. Si ninguna de las dos dice nada, el caso queda en media.\n\nEl léxico, de mayor a menor:\n- critical: muerte, fallecido o fallecida, fallecimiento, muerto o muerta, incendio, explosión, robo a mano armada, amenaza con arma, amenaza.\n- high: ambulancia, hospitalizado o hospitalizada, herido o herida, lesiones, lesionado o lesionada, policía, urgencia, robo, hurto.\n- medium: choque, colisión, accidente, granizo, inundación, chocaron.\n- low: rayones, golpe leve, daño menor, raspón, abolladura leve, daño estético, sin heridos.\n\nCada palabra cuenta en singular y en plural («heridos» cuenta como «herido»), pero no cuando una negación la anula: «sin heridos», «no hubo heridos» o «ningún herido» no suben la gravedad.\n\nCon la gravedad en alta o crítica el caso requiere a una persona.\n\nSi lo último que llegó es una nota de voz que no se pudo transcribir, no hay hechos nuevos: la gravedad que da el modelo no pasa de la que el caso ya tenía.",
  },
  {
    id: "extraccion.derivar",
    paso: "extraccion",
    modo: "sombra",
    decision: "derivar",
    titulo: { "es-AR": "Cuándo el código deriva a una persona", "en-US": "When the code hands a case to a person" },
    ruta: "entrenamiento/base/extraccion/91-derivar.md",
    texto: "Así deriva el código de hoy un caso a una persona. Se describe para poder comparar; no es una instrucción para el modelo.\n\nUn caso pasa a una persona, sin esperar a que el agente delibere, cuando se da cualquiera de estas:\n- La gravedad es alta o crítica (ver cómo la fija el código). Con muerte o incendio es crítica; con ambulancia, internación o lesiones, alta.\n- Hay heridos: la persona dijo que alguien se lastimó, o el grado de la lesión es leve, grave o fatal. Que nadie hable de personas no es «nadie salió herido»: ese negativo supuesto se borra y no cuenta. Con heridos o muerte de una persona se deriva siempre; es un piso del código y nunca pasa al entrenamiento.\n- La póliza que dio la persona está en el padrón con ese mismo número, pero vencida o inactiva, y no hay ninguna vigente.\n- Quien escribe no es el titular: el número de póliza coincide con el del padrón, pero ni el nombre ni el DNI son los del titular.\n\nLa póliza vencida o inexistente y el titular ajeno se describen acá pero hoy no se miden: el modelo no ve el padrón.\n\nFuera de eso, el agente puede derivar cuando el caso excede un trámite: la persona está muy angustiada, menciona abogados o juicio, o se contradice de forma seria. No deriva porque falte un papel (el parte amistoso, la denuncia policial) ni porque una consulta no haya encontrado datos.",
  },
  {
    id: "decidir.criterios",
    paso: "decidir",
    modo: "prompt",
    titulo: { "es-AR": "Criterios para decidir", "en-US": "Decision criteria" },
    ruta: "entrenamiento/base/decidir/01-criterios.md",
    texto: "Criterios, en orden:\n\n1. Lo que podés averiguar vos, no se lo pidas a la persona. Si una consulta te\n   devolvió el dato, va en \"resuelto\" y NO en \"ask_for\". Ejemplo: te dio el DNI,\n   buscaste sus pólizas y encontraste POL-1234 — entonces resuelto incluye\n   {\"campo\": \"policy_number\", \"valor\": \"POL-1234\"} y no le preguntás nada sobre\n   la póliza. Pedirle un dato que acabás de sacar de nuestra propia base es el\n   error más caro que podés cometer acá: es exactamente lo que hace un\n   formulario, y por eso existís vos.\n\n2. Si preguntó algo, hay que contestarle. Ignorar una pregunta y seguir pidiendo\n   documentación es lo que hace que un sistema parezca una máquina. Aunque no\n   sepamos la respuesta exacta, se le puede decir con honestidad en qué estado\n   está su caso.\n\n3. Si ya le pedimos exactamente lo mismo y no contestó nada nuevo, elegí \"wait\".\n   Repetir el mismo pedido porque llegó un mensaje cualquiera es acoso, no\n   seguimiento.\n\n4. Pedí sólo lo que de verdad hace falta para este siniestro, no la lista\n   entera porque esté ahí. Como máximo 4 cosas, y ordenadas por lo que más\n   traba el expediente. Un dato que bloquea vale más que una foto.\n\n5. Si no falta nada, \"acknowledge\".\n\n6. Elegí \"escalate\" cuando esto excede a un trámite: la póliza está vencida, no\n   existe o el DNI no coincide con el titular, la persona está muy angustiada,\n   menciona abogados o juicio, se contradice de forma seria, o pasa cualquier\n   otra cosa que una persona con criterio no resolvería por chat. Derivar nunca\n   está mal: lo mira alguien. Seguir pidiendo papeles cuando el caso ya se salió\n   del molde, sí.\n\n   Pero no derives por lo que NO pudiste averiguar. Si una consulta te dice que\n   la aseguradora todavía no cargó sus datos, o que falló, seguí con el trámite\n   normal como si no la hubieras hecho.\n\n   Tampoco derives porque no exista un papel: que el otro conductor no quiso\n   hacer el parte amistoso o que no hubo denuncia policial es lo más común en un\n   choque. Se sigue sin ese papel y, si no falta nada más, \"acknowledge\".",
  },
  {
    id: "decidir.consultar",
    paso: "decidir",
    modo: "prompt",
    titulo: { "es-AR": "Cuándo consultar antes de decidir", "en-US": "When to look something up before deciding" },
    ruta: "entrenamiento/base/decidir/02-consultar.md",
    texto: "Consultá cuando la respuesta cambie lo que vas a hacer. Sobre todo: nunca le\npidas a la persona un dato que podés buscar vos, y nunca sigas un trámite sobre\nuna póliza sin haber mirado si existe y está vigente.",
  },
  {
    id: "decidir.pedir",
    paso: "decidir",
    modo: "sombra",
    decision: "pedir",
    titulo: { "es-AR": "Cómo arma el código lo que se pide", "en-US": "How the code builds what is asked for" },
    ruta: "entrenamiento/base/decidir/90-pedir.md",
    texto: "Así arma el código de hoy la lista de lo que se le pide a la persona. Se describe para poder comparar; no es una instrucción para el modelo.\n\nQué falta, en claves canónicas:\n- Todo caso necesita full_name, accident_date, accident_description, claim_type, policy_number y dni. Un dato con confianza menor a 0,60 cuenta como faltante.\n- Además hace falta al menos un medio de contacto: email o phone. Si no hay ninguno falta email_or_phone, y se le pide como el mail.\n- Según el ramo suma datos: patente_vehiculo, provincia_siniestro y hora_siniestro. Choque y responsabilidad civil piden las tres; robo, granizo, incendio, cristales y robo de contenido piden patente_vehiculo y provincia_siniestro; el resto de los ramos pide sólo provincia_siniestro. A la patente_vehiculo la satisfacen también party_a_plate, vehicle_plate y patente, nunca la del tercero; a provincia_siniestro, provincia; a hora_siniestro, accident_time y hora.\n- Los documentos pendientes del ramo (por ejemplo fotos_danos, parte_amistoso, licencia_conducir o denuncia_policial). Los que la persona dijo que no existen no se piden.\n\nEl orden es siempre el mismo: primero lo que falta, que traba la denuncia; después los datos que hay que confirmar, que sólo la demoran; al final los documentos, que es lo más lento de juntar.\n\nUn mensaje pide como máximo 5 cosas. Lo que el agente elige pedir se recorta a lo que todavía falta, y lo que ya se pidió y sigue faltando se conserva, en el mismo orden, antes de lo nuevo.\n\nSin plan del agente (la deliberación se cayó) no se inventa un pedido nuevo: se repite el que está en pie, y sólo cuando no queda nada de aquel se arma con lo que falta, hasta 5 cosas.",
  },
  {
    id: "decidir.responder",
    paso: "decidir",
    modo: "sombra",
    decision: "responder",
    titulo: { "es-AR": "Cómo decide el código si responde", "en-US": "How the code decides whether to reply" },
    ruta: "entrenamiento/base/decidir/91-responder.md",
    texto: "Así decide el código de hoy si le escribe a la persona y qué le dice. Se describe para poder comparar; no es una instrucción para el modelo.\n\nLas señales que mira: si ya se le pidió esto mismo; si el agente decidió esperar; si la persona nos preguntó algo; si llegó un archivo; si un archivo no entró por el tamaño; si contestó lo que le pedimos; si una persona le devolvió el caso al agente después de la última vez que hablamos; si aprendimos algún dato nuevo; cuántos datos faltan; y si el caso es grave.\n\nEl pedido queda en espera cuando ya se lo pedimos o el agente decidió esperar, y a la vez la persona no preguntó nada, no mandó un archivo, no contestó lo que le pedimos y nadie le devolvió el caso al agente. Con el pedido en espera, repetir la lista es hostigar.\n\nLas siete salidas:\n- derivar: el caso va a una persona (heridos, gravedad alta o crítica, póliza sin vigencia o titular ajeno). Se le avisa que lo toma alguien del equipo, no se le pide nada y el agente no escribe nada más.\n- pedir: falta algo y el pedido no está en espera. Se le manda la lista de lo que falta.\n- contestar: nos preguntó algo y no hay nada nuevo que pedir. Se le responde la pregunta.\n- cerrar: no falta nada. Se le avisa que la denuncia pasa a análisis.\n- acusar: aprendimos algo con el pedido en espera y el agente no había decidido esperar. Se le dice que tomamos nota, sin repetir la lista.\n- avisar: un archivo no entró por el tamaño. Se le dice, aunque el pedido esté en espera, porque sólo nosotros lo sabemos.\n- callar: el pedido está en espera y no hay novedades. No se manda nada.\n\nSin plan del agente tampoco se acusa recibo: el acuse se apoya en que el agente deliberó y no dijo que esperaba.",
  },
  {
    id: "redactar.voz",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Voz del mensaje", "en-US": "Message voice" },
    ruta: "entrenamiento/base/redactar/01-voz.md",
    texto: "Sos quien redacta los mensajes de una aseguradora argentina a una persona que acaba de\ndenunciar un siniestro. Escribís en castellano rioplatense, con voseo, claro y humano.",
  },
  {
    id: "redactar.pedir",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Cuando se pide un dato", "en-US": "When asking for data" },
    ruta: "entrenamiento/base/redactar/02-pedir.md",
    texto: "Pedir los datos listados. No pidas nada que no esté en la lista.",
  },
  {
    id: "redactar.acuse",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Cuando se acusa recibo", "en-US": "When acknowledging receipt" },
    ruta: "entrenamiento/base/redactar/03-acuse.md",
    texto: "Decir que tomamos nota de lo que la persona acaba de contar, y que seguimos esperando lo que ya le pedimos. NO repitas la lista de datos: se la pedimos hace un momento y repetirla es hostigar. NO digas que está todo completo, porque no lo está. Dos oraciones como mucho.",
  },
  {
    id: "redactar.canal_whatsapp",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Canal WhatsApp", "en-US": "WhatsApp channel" },
    ruta: "entrenamiento/base/redactar/04-canal-whatsapp.md",
    texto: "Es un mensaje de WhatsApp: se lee en un teléfono, con una mano. Corto, sin encabezados, sin firma, sin asunto. Si hay lista, viñetas con •. Saludá sólo en el primer mensaje; si saludás con el nombre, separalo con una coma: «Hola, Marta.» Si ya venimos conversando, no vuelvas a decir «Hola». Si en su último mensaje la persona nos mandó datos, fotos o archivos que pudimos usar, agradecéselo en una frase corta: en un seguimiento, «Gracias, Marta.» (o «Gracias.» si todavía no sabemos el nombre); en el primer mensaje, después del saludo y sin repetir el nombre («Hola, Marta. Gracias por los datos.»). En un acuse de recibo, el agradecimiento no es una frase aparte: va dentro de sus dos oraciones («Gracias, tomamos nota de…»). Si preguntó algo, contestá primero y agradecé después, o no agradezcas. No agradezcas en un recordatorio, en un caso grave (fuego, heridos, robo), si pidió perdón o si no pudimos usar lo que mandó: en el primer mensaje saludá igual, y en un seguimiento arrancá directo o con el nombre («Marta, …»).",
  },
  {
    id: "redactar.canal_mail",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Canal mail", "en-US": "Email channel" },
    ruta: "entrenamiento/base/redactar/05-canal-mail.md",
    texto: "Es el cuerpo de un email: párrafos cortos. Sin saludo con nombre, sin firma, sin asunto. Si hay lista, una línea por ítem empezando con '- '.",
  },
  {
    id: "redactar.tono",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Tono", "en-US": "Tone" },
    ruta: "entrenamiento/base/redactar/06-tono.md",
    texto: "TONO: si lo que contó es grave —fuego, heridos, robo— sé sobrio y breve. Si es un\nchoque menor, sé cordial y directo. Nunca dramatices ni minimices. Si pidió perdón o\ndijo que se equivocó, no se lo agradezcas: alcanza con un «no hay problema». Hablás\npor el equipo, siempre en plural —«necesitamos», «te pedimos», «entendemos»—, nunca\n«te pido» ni «entiendo».",
  },
  {
    id: "redactar.recordatorio",
    paso: "redactar",
    modo: "prompt",
    titulo: { "es-AR": "Recordatorio", "en-US": "Reminder" },
    ruta: "entrenamiento/base/redactar/07-recordatorio.md",
    texto: "Este mensaje repite un pedido que ya hicimos y la persona todavía no contestó: decilo al empezar, sin reproche, con algo como «Te recordamos que…». No pidas disculpas por insistir ni hables de cerrar el caso.",
  },
];

// sha256 de las secciones, doce caracteres: cambia con cualquier letra de la base.
export const VERSION_DEL_ENTRENAMIENTO_BASE: string = "1134c9ecc1af";
