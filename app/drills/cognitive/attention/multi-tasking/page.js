import MultiTaskingClient from './DualTargetFlowClient';

// ============================================================
// SEO RESEARCH FINDINGS — multi-tasking
// PRIMARY:  "multitasking test"             ~8,100/mo, KD ~30%
// SECONDARY:"multitasking games"            ~5,400/mo, KD ~22%
//           "multitasking brain training"   ~1,600/mo, KD ~20%
//           "multitasking test online free" ~1,900/mo, KD ~25%
//           "can humans actually multitask" ~2,400/mo, KD ~28%
// LONG-TAIL:"how to improve multitasking skills" ~1,200/mo
//           "multitasking vs task switching"~590/mo
//           "cognitive flexibility multitasking" ~390/mo
// INTENT:   Test / Informational / Game
// COMPETITORS: Human Benchmark, Psychology Today, Lumosity
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Attention", "item": "https://skilldrills.online/drills/cognitive/attention" },
              { "@type": "ListItem", "position": 4, "name": "Multi Tasking" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Multitasking Test – Free Dual Target Flow Cognitive Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online multitasking test and brain training game. Handle multiple simultaneous targets and tasks to build cognitive flexibility, reduce context switching costs, and improve real-world multitasking performance.",
  "genre": "Cognitive Brain Training / Multitasking",
  "url": "https://skilldrills.online/drills/cognitive/attention/multi-tasking",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "1152" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Can humans actually multitask?",
      "acceptedAnswer": { "@type": "Answer", "text": "True simultaneous multitasking is largely a myth for cognitive tasks. What humans call multitasking is actually rapid task switching — alternating between tasks very quickly. The brain serializes most cognitive work, but the speed and efficiency of this switching can be significantly improved with targeted training." }
    },
    {
      "@type": "Question",
      "name": "What is the difference between multitasking and task switching?",
      "acceptedAnswer": { "@type": "Answer", "text": "Multitasking implies parallel processing two cognitive tasks simultaneously. Task switching (set-shifting) is the rapid alternation between tasks. Research shows that most human multitasking is high-speed task switching. Each switch carries a 'switch cost' — a brief latency and accuracy penalty while the brain reloads the new task's rules." }
    },
    {
      "@type": "Question",
      "name": "How can I improve my multitasking skills?",
      "acceptedAnswer": { "@type": "Answer", "text": "Effective multitasking improvement comes from: (1) practicing tasks that use different sensory channels simultaneously, (2) training rapid rule-switching with minimal errors, and (3) building automaticity in component tasks so they demand less conscious oversight. This drill exercises all three through its dual-target flow mechanics." }
    },
    {
      "@type": "Question",
      "name": "Why does multitasking drain mental energy?",
      "acceptedAnswer": { "@type": "Answer", "text": "Each task-set reconfiguration requires the prefrontal cortex to disengage old task rules, flush working memory, and load new task parameters. This cognitive overhead consumes glucose and neurotransmitters rapidly. The cumulative energy cost of many switches explains the brain drain of multitasking-heavy workdays." }
    },
    {
      "@type": "Question",
      "name": "What are the negative effects of multitasking on performance?",
      "acceptedAnswer": { "@type": "Answer", "text": "Studies show unregulated multitasking can reduce task performance quality by up to 40%, increase error rates, fragment attention, and elevate cortisol. However, trained and structured multitasking with clear task boundaries and practiced switching can dramatically reduce these penalties." }
    },
    {
      "@type": "Question",
      "name": "What does this multitasking test measure?",
      "acceptedAnswer": { "@type": "Answer", "text": "This dual-target flow test measures your ability to track and respond to multiple concurrent tasks with overlapping deadlines. It evaluates your accuracy across parallel streams, your switching speed when task demands converge, and how well you maintain performance across both channels under increasing cognitive load." }
    },
    {
      "@type": "Question",
      "name": "How does executive function control multitasking?",
      "acceptedAnswer": { "@type": "Answer", "text": "The dorsolateral prefrontal cortex acts as the central executive, maintaining multiple task representations in working memory, deciding which task gets priority at any moment, and managing the motor output queue. Multitasking training directly strengthens this executive control network." }
    },
    {
      "@type": "Question",
      "name": "Can multitasking games improve work productivity?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. By training your brain's task-switching latency and executive control, multitasking games help you manage real work streams more efficiently. You will find it easier to maintain quality across multiple projects, handle interruptions, and return to primary tasks with less context reload time." }
    },
    {
      "@type": "Question",
      "name": "Who benefits most from multitasking training?",
      "acceptedAnswer": { "@type": "Answer", "text": "Air traffic controllers, emergency dispatchers, surgeons, esports players, teachers, project managers, stock traders, and emergency first responders are among the professions where high-quality multitasking or rapid task-switching is a critical performance variable. This drill targets all these audiences." }
    },
    {
      "@type": "Question",
      "name": "Is this multitasking test free to play?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The Dual Target Flow multitasking drill on SkillDrills is completely free with no registration, downloads, or subscriptions required. It runs directly in your web browser." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Take the Multitasking Test",
  "description": "Test and train your divided attention and multitasking efficiency by managing dual target flows.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Observe Active Targets",
      "text": "Identify the active target shapes displayed at the top of the left and right panels."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Track Spawning Shapes",
      "text": "Shapes will spawn from the sides of the panels and move across the screen."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Click Matching Shapes Only",
      "text": "Click or tap ONLY on the shapes that match the active target shapes for that panel. Ignore all other distractor shapes."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Survive the Speed Scaling",
      "text": "Every correct hit adds time (+7s) to your clock. Avoid errors and build combos to level up and push your score limit."
    }
  ]
};

export const metadata = {
  title: "Multitasking Test | Dual Target Flow Brain Training | SkillDrills",
  description: "Take our free online multitasking test. Challenge your brain with dual-target tracking and improve cognitive flexibility. No sign-up required.",
  keywords: [
    "multitasking test",
    "multitasking games",
    "multitasking test online free",
    "multitasking brain training",
    "can humans multitask",
    "how to improve multitasking skills",
    "multitasking vs task switching",
    "dual task flow game",
    "cognitive flexibility multitasking",
    "multitasking challenge game",
    "context switching cost",
    "executive function training"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/attention/multi-tasking",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Multitasking Test | Dual Target Flow Brain Training | SkillDrills",
    description: "Take our free online multitasking test. Challenge your brain with dual-target tracking and improve cognitive flexibility. No sign-up required.",
    url: "https://skilldrills.online/drills/cognitive/attention/multi-tasking",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Multitasking Test – Dual-Task Cognitive Flexibility Game" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Multitasking Test | Dual Target Flow Brain Training | SkillDrills",
    description: "Take our free online multitasking test. Challenge your brain with dual-target tracking and improve cognitive flexibility. No sign-up required.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function MultiTaskingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <MultiTaskingClient />
    </>
  );
}
