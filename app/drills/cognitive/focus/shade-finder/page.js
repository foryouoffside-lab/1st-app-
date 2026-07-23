import ShadeFinderClient from './ShadeFinderClient';

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
    { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
    { "@type": "ListItem", "position": 3, "name": "Focus", "item": "https://skilldrills.online/drills/cognitive/focus" },
    { "@type": "ListItem", "position": 4, "name": "Shade Finder" }
  ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Shade Finder – Free Online Color Acuity & Visual Search Test",
  "applicationCategory": "EducationalApplication",
  "operatingSystem": "All",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Train your visual focus and color acuity. Find the square with the different color shade in a dynamic grid. Based on visual search cognitive paradigms. Test your vision and speed.",
  "url": "https://skilldrills.online/drills/cognitive/focus/shade-finder",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "890" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is the Shade Finder test?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A visual acuity and focus test where you identify the single odd shade color block in a dynamic grid of squares."
      }
    },
    {
      "@type": "Question",
      "name": "How do the lives work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "You start with 3 lives. Tapping the wrong square or failing to react before the round timer expires costs 1 life. The game ends when lives reach 0 or the 45-second overall timer runs out."
      }
    },
    {
      "@type": "Question",
      "name": "How does the difficulty scale?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "As your score and level increase, the grid dimensions grow from 2x2 up to 8x8, and the shade difference between the target square and the rest of the grid becomes progressively smaller and harder to detect."
      }
    },
    {
      "@type": "Question",
      "name": "Is this color test free?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, Shade Finder on SkillDrills is 100% free, running directly in any web browser on desktop and mobile without registration."
      }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Train Attention with Shade Finder Color Game",
  "description": "Improve visual scanning speed and target isolation under color contrast using the free online Shade Finder.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Scan the Grid",
      "text": "Quickly scan the grid of colored blocks on the screen."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Spot the Odd Shade",
      "text": "Find the single block that has a slightly lighter or darker color shade than all the others."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Tap to Strike",
      "text": "Click or tap the odd block to earn score and build a combo before the round timer expires."
    }
  ]
};

export const metadata = {
  title: "Shade Finder | Free Online Color Acuity & Visual Search Test",
  description: "Train your focus and color acuity with our free online shade finder. Spot the odd color block in a dynamic grid. Start training now.",
  keywords: [
    "shade finder online",
    "color vision test free",
    "spot the difference color",
    "visual search test online",
    "odd shade out",
    "kuku kube test"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/focus/shade-finder",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Shade Finder | Free Online Color Acuity & Visual Search Test",
    description: "Train your focus and color acuity with our free online shade finder. Spot the odd color block in a dynamic grid. Start training now.",
    url: "https://skilldrills.online/drills/cognitive/focus/shade-finder",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Shade Finder Test" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Shade Finder | Free Online Color Acuity & Visual Search Test",
    description: "Train your focus and color acuity with our free online shade finder. Spot the odd color block in a dynamic grid. Start training now.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function ShadeFinderPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <ShadeFinderClient />
    </>
  );
}
