// The terms of use. PLACEHOLDER TEXT awaiting a lawyer: every [BRACKET] and every
// section needs their review (docs/ALLERGY_LEGAL_REVIEW.md), and the Spanish must
// follow the English once it's final. When it's done, clear TERMS_DRAFT.
import type { Locale } from "../../i18n";

export interface TermsSection {
  title: string;
  points: string[];
}

const en: TermsSection[] = [
  {
    title: "What HandShake is",
    points: [
      "HandShake is software that lets customers, stores and drivers deal with each other directly. It's published by [LEGAL ENTITY NAME].",
      "[LEGAL ENTITY NAME] doesn't sell, make, handle or deliver food, isn't a party to any order, doesn't hold your money and doesn't employ stores or drivers.",
      "[COUNSEL: confirm this description, and how it fits who runs a network's servers and publishes updates.]",
    ],
  },
  {
    title: "Food, allergens and safety",
    points: [
      "Each store is responsible for its food, including what it says about ingredients and allergens, and for following the food rules where it operates.",
      "Allergen information comes from stores. It may be wrong or missing, and kitchens can cross-contact. A warning, or no warning, in the app doesn't mean a food is safe for you.",
      "If you have a serious allergy, ask the store directly before ordering. In a medical emergency, call emergency services.",
    ],
  },
  {
    title: "Stores and drivers",
    points: [
      "If you sell or deliver through HandShake, you're responsible for your own licences, insurance, taxes, payment accounts and legal obligations, and for keeping what you say accurate.",
      "You agree to cover [LEGAL ENTITY NAME]'s losses from claims arising out of your food, your deliveries, your statements or your breach of these terms. [COUNSEL: indemnity wording and limits.]",
    ],
  },
  {
    title: "Payments",
    points: [
      "Payments are made directly on each store's and driver's own payment processor account, under that processor's terms. [LEGAL ENTITY NAME] doesn't receive or hold them.",
    ],
  },
  {
    title: "Your data",
    points: [
      "Much of what you do is written to a shared network, copied between people's devices, and can't be deleted. What's sealed can only be opened by the people it's sealed to. The app's policies say what's public.",
      "Allergies you save or send may be health information. You choose to save them, and whether to send them with each order.",
      "[COUNSEL: privacy policy, health data consent, and deletion rights under GDPR, UK GDPR, Washington's My Health My Data Act and others.]",
    ],
  },
  {
    title: "No warranty",
    points: [
      "As far as the law allows, HandShake is provided \"as is\" and \"as available\", without warranties of any kind, including of merchantability, fitness for a particular purpose, accuracy or non-infringement. It's experimental software and may have bugs.",
    ],
  },
  {
    title: "Limit of liability",
    points: [
      "As far as the law allows, [LEGAL ENTITY NAME] isn't liable for indirect, incidental, special or consequential damages, or for the acts of any store, driver or customer, and its total liability is limited to [AMOUNT].",
      "Nothing in these terms limits rights or liability that the law doesn't allow to be limited. [COUNSEL: personal injury, gross negligence and consumer law carve-outs, by place.]",
    ],
  },
  {
    title: "Disputes and governing law",
    points: [
      "These terms are governed by the laws of [STATE OR COUNTRY]. [COUNSEL: venue, and whether to use arbitration and a class action waiver.]",
    ],
  },
  {
    title: "Who can use it, and changes",
    points: [
      "You must be at least [MINIMUM AGE] to use HandShake.",
      "If these terms change, the app asks you to agree again before you carry on. If you don't agree, stop using it.",
      "The software itself is licensed separately under the PolyForm Shield License 1.0.0, with third-party components under their own licenses. Contact: [CONTACT].",
    ],
  },
];

const es: TermsSection[] = [
  {
    title: "Qué es HandShake",
    points: [
      "HandShake es un software que permite a clientes, tiendas y repartidores tratar directamente entre sí. Lo publica [NOMBRE DE LA ENTIDAD LEGAL].",
      "[NOMBRE DE LA ENTIDAD LEGAL] no vende, prepara, manipula ni entrega comida, no es parte de ningún pedido, no guarda tu dinero y no emplea a tiendas ni repartidores.",
      "[ABOGADO: confirmar esta descripción y cómo encaja con quien opera los servidores de una red y publica las actualizaciones.]",
    ],
  },
  {
    title: "Comida, alérgenos y seguridad",
    points: [
      "Cada tienda es responsable de su comida, incluido lo que dice sobre ingredientes y alérgenos, y de cumplir las normas alimentarias de donde opera.",
      "La información sobre alérgenos procede de las tiendas. Puede ser incorrecta o faltar, y en las cocinas puede haber contacto cruzado. Un aviso, o la falta de aviso, en la app no significa que una comida sea segura para ti.",
      "Si tienes una alergia grave, pregunta directamente a la tienda antes de pedir. En una emergencia médica, llama a emergencias.",
    ],
  },
  {
    title: "Tiendas y repartidores",
    points: [
      "Si vendes o repartes a través de HandShake, eres responsable de tus licencias, seguros, impuestos, cuentas de pago y obligaciones legales, y de que lo que dices sea exacto.",
      "Aceptas cubrir las pérdidas de [NOMBRE DE LA ENTIDAD LEGAL] por reclamaciones derivadas de tu comida, tus entregas, tus declaraciones o tu incumplimiento de estas condiciones. [ABOGADO: redacción y límites de la indemnización.]",
    ],
  },
  {
    title: "Pagos",
    points: [
      "Los pagos se hacen directamente en la cuenta del procesador de pagos de cada tienda y repartidor, según las condiciones de ese procesador. [NOMBRE DE LA ENTIDAD LEGAL] no los recibe ni los guarda.",
    ],
  },
  {
    title: "Tus datos",
    points: [
      "Gran parte de lo que haces se escribe en una red compartida, se copia entre dispositivos de otras personas y no se puede borrar. Lo sellado solo pueden abrirlo las personas para quienes se selló. Las políticas de la app indican qué es público.",
      "Las alergias que guardas o envías pueden ser información de salud. Tú decides guardarlas y si las envías con cada pedido.",
      "[ABOGADO: política de privacidad, consentimiento sobre datos de salud y derechos de supresión según el RGPD, el RGPD del Reino Unido, la ley My Health My Data de Washington y otras.]",
    ],
  },
  {
    title: "Sin garantía",
    points: [
      "En la medida en que la ley lo permita, HandShake se ofrece \"tal cual\" y \"según disponibilidad\", sin garantías de ningún tipo, incluidas las de comerciabilidad, idoneidad para un fin concreto, exactitud o no infracción. Es software experimental y puede tener errores.",
    ],
  },
  {
    title: "Límite de responsabilidad",
    points: [
      "En la medida en que la ley lo permita, [NOMBRE DE LA ENTIDAD LEGAL] no responde de daños indirectos, incidentales, especiales o consecuentes, ni de los actos de ninguna tienda, repartidor o cliente, y su responsabilidad total se limita a [IMPORTE].",
      "Nada en estas condiciones limita los derechos o la responsabilidad que la ley no permite limitar. [ABOGADO: excepciones por lesiones personales, negligencia grave y consumo, según el lugar.]",
    ],
  },
  {
    title: "Disputas y ley aplicable",
    points: [
      "Estas condiciones se rigen por las leyes de [ESTADO O PAÍS]. [ABOGADO: jurisdicción, y si usar arbitraje y renuncia a demandas colectivas.]",
    ],
  },
  {
    title: "Quién puede usarlo, y cambios",
    points: [
      "Debes tener al menos [EDAD MÍNIMA] para usar HandShake.",
      "Si estas condiciones cambian, la app te pedirá aceptarlas de nuevo antes de continuar. Si no estás de acuerdo, deja de usarla.",
      "El software en sí tiene una licencia aparte, la PolyForm Shield License 1.0.0, y los componentes de terceros tienen las suyas. Contacto: [CONTACTO].",
    ],
  },
];

export const TERMS: Record<Locale, TermsSection[]> = { en, es };
