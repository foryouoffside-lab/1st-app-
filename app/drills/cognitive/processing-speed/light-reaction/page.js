import StrobeLatencyClient from './StrobeLatencyClient';

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Processing Speed", "item": "https://skilldrills.online/drills/cognitive/processing-speed" },
              { "@type": "ListItem", "position": 4, "name": "Light Reaction" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Light Reaction Time Test – Free Visual Reflex Game",
  "applicationCategory": "EducationalApplication",
  "operatingSystem": "All",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online visual reaction test. Click the screen as soon as the target flashes to measure your reaction latency in milliseconds.",
  "url": "https://skilldrills.online/drills/cognitive/processing-speed/light-reaction",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "980" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is the Light Reaction test?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A simple reaction time test where you must click the target as fast as possible when it flashes white."
      }
    },
    {
      "@type": "Question",
      "name": "How does the difficulty scale?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "As your score increases, the flash duration window shrinks, requiring faster motor responses to register hits."
      }
    },
    {
      "@type": "Question",
      "name": "What is a good reaction speed?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Average human visual reaction time is around 250ms. Elite gamers and athletes can react within 150-180ms."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need to sign up?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No registration is required. The Light Reaction test is completely free and works instantly in your browser."
      }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Measure Your Visual Reaction Time Online",
  "description": "Quickly test and train your visual reflex speeds using our simple Light Reaction game.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Focus on the Circle",
      "text": "Start the drill and keep your eyes locked on the dark central circle."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Wait for the White Flash",
      "text": "Wait for the circle to flash white. Intervals are randomized to prevent anticipation."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Click or Tap Instantly",
      "text": "Click or tap the target as fast as you can. Your reaction time will be recorded in milliseconds."
    }
  ]
};

export const metadata = {
  title: "Light Reaction Time Test | Free Visual Reflex Training Game | SkillDrills",
  description: "Test your visual reaction speed online. Click the screen as soon as the target flashes to measure your reaction latency in milliseconds.",
  keywords: [
    "light reaction test",
    "visual reaction time test",
    "reflex training game",
    "reaction speed test",
    "strobe latency test online",
    "simple reaction time test"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/processing-speed/light-reaction",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Light Reaction Time Test | Free Visual Reflex Training Game | SkillDrills",
    description: "Test your visual reaction speed online. Click the screen as soon as the target flashes to measure your reaction latency in milliseconds.",
    url: "https://skilldrills.online/drills/cognitive/processing-speed/light-reaction",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Light Reaction Time Test" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Light Reaction Time Test | Free Visual Reflex Training Game | SkillDrills",
    description: "Test your visual reaction speed online. Click the screen as soon as the target flashes to measure your reaction latency in milliseconds.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function StrobeLatencyPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <StrobeLatencyClient />
    </>
  );
}