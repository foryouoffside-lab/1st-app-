import QuickDodgeClient from './QuickDodgeClient';

// ============================================================
// SEO RESEARCH FINDINGS — quick-dodge
// PRIMARY: "reflex game online"       ~3,600/mo, KD ~25%
//          "dodge game"               ~1,900/mo, KD ~28%
// SECONDARY / LSI:
//   "reaction time game"              ~1,300/mo, KD ~22%
//   "mouse accuracy game"             ~1,300/mo, KD ~20%
//   "cursor dodge game"               ~110/mo,    KD ~12%
//   "reflex training"                 ~3,600/mo, KD ~30%
// PAA targets: "What is a Reflex Game Online?", "How does this dodge challenge improve coordination?",
//   "Does this improve FPS gaming?", "Is this good for Valorant or CS2?",
//   "Is this free?"
// ============================================================

export const metadata = {
  title: 'Reflex Game Online - Free Dodge Challenge & Mouse Training | SkillDrills',
  description: 'Train reflexes, mouse control, spatial awareness and survival skills in this free browser dodge game. Dodge increasingly aggressive homing enemies and build huge streaks.',
  keywords: [
    // Primary / Head terms
    'reflex game online', 'dodge game',
    // Secondary / LSI terms
    'reaction time game', 'mouse accuracy game', 'cursor dodge game', 'reflex training',
    'hand eye coordination game', 'reaction speed test', 'dodge challenge',
    // Long-tail variants
    'free online browser reflex game', 'improve mouse control dodge obstacles',
    'survival reflex game for gamers', 'esports cursor agility trainer'
  ],
  alternates: {
    canonical: 'https://skilldrills.online/drills/cognitive/processing-speed/quick-dodge',
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Reflex Game Online - Free Dodge Challenge & Mouse Training | SkillDrills',
    description: 'Survive the chaos. Train your reflexes, mouse accuracy, and spatial awareness in this adaptive browser dodge game. No sign-up required.',
    url: 'https://skilldrills.online/drills/cognitive/processing-speed/quick-dodge',
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{
      url: 'https://skilldrills.online/icons/icon-512x512.png',
      width: 512,
      height: 512,
      alt: 'Reflex Game Online - Dodge Challenge | SkillDrills',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Reflex Game Online - Free Dodge Challenge & Mouse Training',
    description: 'Dodge aggressive homing enemies, build huge combo streaks, and survive as long as possible in this elite reflex training game.',
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

// --- Structured Data ---

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Processing Speed", "item": "https://skilldrills.online/drills/cognitive/processing-speed" },
              { "@type": "ListItem", "position": 4, "name": "Quick Dodge" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "Reflex Game Online - Free Dodge Challenge & Mouse Training | SkillDrills",
  "url": "https://skilldrills.online/drills/cognitive/processing-speed/quick-dodge",
  "description": "Free browser reflex game and mouse control trainer. Dodge homing obstacles to earn time and score. Features Adrenaline Mode, pressure events, and a 10-level adaptive difficulty engine.",
  "applicationCategory": "EducationalApplication",
  "operatingSystem": "Web Browser",
  "browserRequirements": "Requires a modern web browser with JavaScript support.",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "isAccessibleForFree": true,
  "learningResourceType": "Educational Game",
  "teaches": "Reaction Speed, Reflex Evasion, Evasive Control, Spatial Awareness, Neuromuscular Coordination"
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Play the Reflex Game Online",
  "description": "A step-by-step guide to testing your mouse control and surviving the dynamic dodge challenge.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Engage the Engine",
      "text": "Click the start button to lock your cursor into the raw-input evasion canvas."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Evade the Swarm",
      "text": "Red homing obstacles will spawn at the edges and track your crosshair. Move constantly to let them fly past you and out of bounds."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Build your Combo",
      "text": "Successfully dodging enemies builds your combo multiplier (up to 3.0x). Every dodge also restores +0.6 seconds to your survival clock."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Survive the Chaos",
      "text": "Getting hit violently drains your clock (starting at -5s and scaling worse with each hit). As your score climbs, you will unlock Adrenaline Mode and face 10 levels of extreme speed scaling."
    }
  ]
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is a Reflex Game Online?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A reflex game is an interactive browser drill where players must navigate a cursor to evade dynamic, homing threats. It tests raw reaction speed, spatial awareness, and cursor precision under heavy cognitive load."
      }
    },
    {
      "@type": "Question",
      "name": "How does this dodge challenge improve coordination?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "By forcing you to process multiple peripheral threats simultaneously and execute precise, non-jittery mouse movements to escape tight corridors, it heavily strengthens visual-motor integration."
      }
    },
    {
      "@type": "Question",
      "name": "Does this improve FPS gaming?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. Surviving high-level evasion drills requires elite mouse agility and peripheral scanning. These translate directly to dodging utility, counter-strafing, and fluid crosshair placement in tactical shooters."
      }
    },
    {
      "@type": "Question",
      "name": "Is this good for Valorant or CS2?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Absolutely. The rapid threat identification and repositioning translates directly to dodging flashes, grenades, and ultimate abilities while maintaining crosshair control."
      }
    },
    {
      "@type": "Question",
      "name": "Does it improve hand-eye coordination?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, because you must physically move your mouse to navigate the safe coordinates you visually identified, syncing your visual cortex with your motor cortex."
      }
    },
    {
      "@type": "Question",
      "name": "What is Adrenaline Mode?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Adrenaline Mode is a high-stakes 10-second burst triggered every 250 points. The environment darkens, a heartbeat plays, and all score and time rewards are massively multiplied. It tests your ability to stay calm under intense sensory pressure."
      }
    },
    {
      "@type": "Question",
      "name": "Does the game get harder over time?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, it features a 10-Level adaptive progression. As you score points, the speed increases dramatically (up to 1600px/s) and spawn rates become overwhelming."
      }
    },
    {
      "@type": "Question",
      "name": "Are there penalties for getting hit?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. Getting hit triggers a scaling time deduction. Your first hit costs -5s, but consecutive hits can scale the penalty up to a brutal -10s per hit, forcing you to maintain high evasion accuracy to stay alive."
      }
    },
    {
      "@type": "Question",
      "name": "How does the survival clock work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "You start with 60 seconds. Every dodge adds +0.6s. Perfect streak milestones grant massive time injections (up to +15s). The game ends when the clock hits zero."
      }
    },
    {
      "@type": "Question",
      "name": "Is this free?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes! The SkillDrills Reflex Game Online is entirely free, open-source, and runs purely in your web browser with zero downloads required."
      }
    }
  ]
};

export default function QuickDodgePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <QuickDodgeClient />
    </>
  );
}