import KineticInterceptClient from './KineticInterceptClient';

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Focus", "item": "https://skilldrills.online/drills/cognitive/focus" },
              { "@type": "ListItem", "position": 4, "name": "Moving Target" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Moving Target Click Test – Free Visual Tracking Drill",
  "applicationCategory": "EducationalApplication",
  "operatingSystem": "All",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Train your visual tracking speed and hand-eye coordination. Intercept fast-moving targets spawning from all screen edges and practice precise clicks in this free training game.",
  "url": "https://skilldrills.online/drills/cognitive/focus/moving-target",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "1120" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is the Moving Target click test?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A visual tracking and motor precision drill where you must track and click targets moving rapidly across the screen."
      }
    },
    {
      "@type": "Question",
      "name": "How does visual tracking feedback work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "When your cursor aligns with the moving target, the target glows green, confirming it is locked and ready for intercept selection."
      }
    },
    {
      "@type": "Question",
      "name": "Does this drill scale in difficulty?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, as your score increases, the speed of spawned targets rises and their hitboxes shrink dynamically to test your coordination limits."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need to sign up?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No registration is required. The visual tracking drill is completely free and works instantly in your browser."
      }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Train Your Hand-Eye Coordination with Moving Targets",
  "description": "Test and train your visual pursuit and motor control using our free online Moving Target tracking drill.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Locate Moving Target",
      "text": "Track the white spheres as they spawn and travel from any of the four edges of the screen."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Hover to Lock Target",
      "text": "Move your cursor over the target. The cursor crosshair will turn green to confirm target tracking."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Click to Intercept",
      "text": "Click or tap to capture the target, earning points and extending your time limit."
    }
  ]
};

export const metadata = {
  title: "Moving Target Click Test | Free Visual Tracking Drill | SkillDrills",
  description: "Train your visual tracking speed and hand-eye coordination. Intercept fast-moving targets spawning from all screen edges and practice precise clicks in this free training game.",
  keywords: [
    "moving target training",
    "target tracking drill",
    "moving target click test",
    "kinetic visual tracking game",
    "hand-eye coordination test"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/focus/moving-target",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Moving Target Click Test | Free Visual Tracking Drill | SkillDrills",
    description: "Train your visual tracking speed and hand-eye coordination. Intercept fast-moving targets spawning from all screen edges and practice precise clicks in this free training game.",
    url: "https://skilldrills.online/drills/cognitive/focus/moving-target",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Moving Target Click Test" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Moving Target Click Test | Free Visual Tracking Drill | SkillDrills",
    description: "Train your visual tracking speed and hand-eye coordination. Intercept fast-moving targets spawning from all screen edges and practice precise clicks in this free training game.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function KineticInterceptPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <KineticInterceptClient />
    </>
  );
}