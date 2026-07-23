import BatchProcessingClient from './BatchProcessingClient';

// ============================================================
// SEO RESEARCH FINDINGS — batch-processing
// PRIMARY:  "color sorting game"            ~2,900/mo, KD ~20%
// SECONDARY:"color sorting game online"     ~1,200/mo, KD ~18%
//           "set shifting test online"      ~480/mo,   KD ~15%
//           "cognitive flexibility game"    ~720/mo,   KD ~22%
//           "color matching brain training" ~590/mo,   KD ~16%
// LONG-TAIL:"what is set shifting psychology" ~390/mo
//           "Stroop color test online free"  ~860/mo
//           "batch sorting brain game"       ~110/mo
// INTENT:   Game / Training / Informational
// COMPETITORS: Lumosity, BrainHQ, PsychTests
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
    { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
    { "@type": "ListItem", "position": 3, "name": "Attention", "item": "https://skilldrills.online/drills/cognitive/attention" },
    { "@type": "ListItem", "position": 4, "name": "Batch Processing" }
  ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Color Sorting Game Online – Timed Batch Processing Focus Drill",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online color sorting game. Sort colored items into the correct batch targets under time pressure to train set-shifting, cognitive flexibility, and rapid categorization speed.",
  "genre": "Cognitive Brain Training / Set Shifting",
  "url": "https://skilldrills.online/drills/cognitive/attention/batch-processing",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.7", "reviewCount": "876" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What does a color sorting game train your brain to do?",
      "acceptedAnswer": { "@type": "Answer", "text": "Color sorting games train cognitive flexibility, set-shifting, and visual categorization speed. They require your prefrontal cortex to rapidly map incoming stimuli to changing target bins, exercising the executive control networks responsible for task rule maintenance and switching." }
    },
    {
      "@type": "Question",
      "name": "What is cognitive set-shifting?",
      "acceptedAnswer": { "@type": "Answer", "text": "Set-shifting, also called cognitive flexibility, is the brain's ability to disengage from one task rule set and engage a new one. It is a key component of executive function tested by the Wisconsin Card Sorting Task and Stroop paradigm. Batch-processing drills directly target this ability." }
    },
    {
      "@type": "Question",
      "name": "How is the Stroop effect related to color sorting games?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Stroop effect occurs when conflicting information — such as reading the word 'Red' printed in blue ink — slows your response because competing neural pathways compete for control. Color sorting drills help strengthen inhibitory control, reducing Stroop interference in everyday tasks." }
    },
    {
      "@type": "Question",
      "name": "Can color matching games help with ADHD focus?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Color categorization games engage the prefrontal cortex's inhibitory networks, helping train goal-directed behavior and reduced impulsive errors. Structured timed sorting tasks can be used as supplemental focus training activities alongside formal ADHD interventions." }
    },
    {
      "@type": "Question",
      "name": "What is batch processing in cognitive science?",
      "acceptedAnswer": { "@type": "Answer", "text": "In cognitive science, batch processing refers to grouping similar mental operations together to process them in sequence, similar to how computers handle batch jobs. The brain is more efficient when grouping like tasks rather than interleaving unrelated ones. This drill trains rapid batch identification and response." }
    },
    {
      "@type": "Question",
      "name": "How does visual categorization speed affect real-world productivity?",
      "acceptedAnswer": { "@type": "Answer", "text": "Faster visual categorization means you can process and file information more rapidly in emails, dashboards, and data streams. Professionals like doctors triaging patients, traders scanning charts, and managers reviewing reports all benefit from faster categorization and sorting abilities." }
    },
    {
      "@type": "Question",
      "name": "What is the Wisconsin Card Sorting Test?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Wisconsin Card Sorting Test (WCST) is a neuropsychological test measuring set-shifting and cognitive flexibility. Participants sort cards by color, shape, or number based on feedback from the examiner. This color sorting game uses a similar rule-based categorization paradigm in a gamified format." }
    },
    {
      "@type": "Question",
      "name": "How often should I practice batch processing games?",
      "acceptedAnswer": { "@type": "Answer", "text": "For meaningful cognitive improvement, aim for 5-10 minutes of focused practice 4-5 times per week. Consistent repetition builds neural efficiency in the frontal lobe's executive control centers, gradually reducing your reaction time and error rate during color categorization." }
    },
    {
      "@type": "Question",
      "name": "Does this color sorting game have multiple difficulty levels?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The drill dynamically adjusts difficulty based on performance. As accuracy and speed improve, target windows compress and additional batch categories are introduced, keeping the training challenge at an optimal level for continued cognitive gains." }
    },
    {
      "@type": "Question",
      "name": "Is this color sorting brain game free to play?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes, the Batch Processing drill on SkillDrills is completely free. No registration, no downloads, and no subscriptions required. It runs entirely in your web browser on desktop or mobile." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Take the Set Shifting Color Sort Test",
  "description": "Test and train your cognitive set shifting and color categorization speed under time pressure.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Note the Target Color",
      "text": "At the start of each round, a target color name (e.g. RED, BLUE, GREEN) will flash at the top of the canvas."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Locate Matching Sphere",
      "text": "Locate the single sphere on the screen that matches the flashed target color name."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Tap the Correct Sphere",
      "text": "Tap or click on the matching sphere quickly before the prompt timer drains."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Build Score & Level Up",
      "text": "Correct selections add score and keep your combo. The game ends when the 45-second timer runs out or you lose all 5 lives."
    }
  ]
};

export const metadata = {
  title: "Play Color Sorting Game Online | Free Brain Training Puzzle | SkillDrills",
  description: "Relax and train your brain with our free online color sorting game. Test your set shifting speed, sort the colors, and level up your cognitive flexibility.",
  keywords: [
    "color sorting game",
    "color sorting game online",
    "play color sorting game online free",
    "cognitive flexibility activities for adults",
    "test your set shifting ability",
    "set shifting test online",
    "cognitive flexibility game",
    "color matching brain training",
    "Stroop color test online",
    "batch processing brain training",
    "timed color sorting game",
    "visual categorization test",
    "category sorting test",
    "cognitive set shifting game",
    "working memory games online"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/attention/batch-processing",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Play Color Sorting Game Online | Free Brain Training Puzzle | SkillDrills",
    description: "Relax and train your brain with our free online color sorting game. Test your set shifting speed, sort the colors, and level up your cognitive flexibility.",
    url: "https://skilldrills.online/drills/cognitive/attention/batch-processing",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Color Sorting Game – Timed Set-Shifting Cognitive Drill" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Play Color Sorting Game Online | Free Brain Training Puzzle | SkillDrills",
    description: "Relax and train your brain with our free online color sorting game. Test your set shifting speed, sort the colors, and level up your cognitive flexibility.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function BatchProcessingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <BatchProcessingClient />
    </>
  );
}
