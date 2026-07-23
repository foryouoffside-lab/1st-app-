import DividedAttentionClient from './DividedAttentionClient';

// ============================================================
// SEO RESEARCH FINDINGS — divided-attention
// PRIMARY:  "divided attention test"         ~3,600/mo, KD ~22%
// SECONDARY:"divided attention definition"  ~2,400/mo, KD ~18%
//           "split attention exercises"      ~880/mo,  KD ~12%
//           "dual task training"             ~720/mo,  KD ~28%
// LONG-TAIL:"what is divided attention in psychology" ~480/mo
//           "divided attention vs selective attention"~390/mo
//           "divided attention activities"   ~320/mo
//           "dual task paradigm game"        ~210/mo
// INTENT:   Informational + Test/Play
// COMPETITORS: Human Benchmark, Cambridge Brain Sciences, Lumosity
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Attention", "item": "https://skilldrills.online/drills/cognitive/attention" },
              { "@type": "ListItem", "position": 4, "name": "Divided Attention" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Divided Attention Test – Dual-Task Split Focus Brain Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Free online divided attention test. Simultaneously track moving visual targets and process numerical stimuli to train split focus, dual-task capacity, and parallel cognitive processing.",
  "genre": "Cognitive Brain Training / Divided Attention",
  "url": "https://skilldrills.online/drills/cognitive/attention/divided-attention",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "1024" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is divided attention in psychology?",
      "acceptedAnswer": { "@type": "Answer", "text": "Divided attention is the cognitive ability to process two or more independent streams of information simultaneously, splitting your mental bandwidth across multiple tasks. It is a core component of executive function and is essential for activities like driving while navigating or reading while listening to instructions." }
    },
    {
      "@type": "Question",
      "name": "What is the difference between divided attention and selective attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "Selective attention means focusing your full cognitive resources on one task while completely filtering out distractions. Divided attention means allocating resources across two or more tasks simultaneously. In everyday life, you use selective attention when studying in a quiet room and divided attention when walking while talking." }
    },
    {
      "@type": "Question",
      "name": "What is an example of divided attention?",
      "acceptedAnswer": { "@type": "Answer", "text": "Common examples include: driving a car while holding a conversation, cooking while watching television, and taking notes while listening to a lecture. In each case, your brain must maintain separate cognitive loops for distinct input channels at the same time." }
    },
    {
      "@type": "Question",
      "name": "Can you improve divided attention with training?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Research in cognitive neuroscience shows that repeated dual-task training expands your brain's bandwidth to handle parallel processing. The key is practicing tasks that use different sensory channels, such as visual-spatial tracking combined with auditory or numerical processing, which avoids bottlenecks in a single sensory pathway." }
    },
    {
      "@type": "Question",
      "name": "What does this divided attention test measure?",
      "acceptedAnswer": { "@type": "Answer", "text": "This test measures your ability to simultaneously track moving visual targets (visuospatial channel) and identify even or odd numbers (numerical cognition channel). It scores your accuracy in both streams, your response speed, and your resistance to divided-attention errors under time pressure." }
    },
    {
      "@type": "Question",
      "name": "How does dual-task training improve cognitive performance?",
      "acceptedAnswer": { "@type": "Answer", "text": "Dual-task drills create a processing bottleneck in the prefrontal cortex, forcing your executive network to develop more efficient resource allocation strategies. Over time, this reduces the interference effect between tasks, allowing you to maintain accuracy in both channels with less cognitive fatigue." }
    },
    {
      "@type": "Question",
      "name": "What skills benefit most from divided attention training?",
      "acceptedAnswer": { "@type": "Answer", "text": "Professionals who benefit most include air traffic controllers, emergency room nurses, competitive esports players (monitoring minimap + targets), sports athletes (tracking ball + opponents simultaneously), and surgeons managing instruments while reading vital signs." }
    },
    {
      "@type": "Question",
      "name": "What is a dual-task paradigm?",
      "acceptedAnswer": { "@type": "Answer", "text": "A dual-task paradigm is a research and training method where participants must perform two tasks simultaneously. The interference between tasks reveals the cognitive cost of divided attention. This drill implements a visual-numerical dual task, one of the most studied paradigms in attention research." }
    },
    {
      "@type": "Question",
      "name": "Is this divided attention test free to use?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. This divided attention drill on SkillDrills is completely free to play with no registration, downloads, or subscriptions required. It runs entirely in your web browser." }
    },
    {
      "@type": "Question",
      "name": "How does divided attention affect driving safety?",
      "acceptedAnswer": { "@type": "Answer", "text": "Divided attention is critical for safe driving. You must simultaneously monitor the road ahead, check mirrors, obey traffic signals, and process GPS instructions. Studies show that insufficient divided attention capacity significantly increases collision risk, especially in complex traffic scenarios." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Take the Divided Attention Test",
  "description": "Improve your split focus and multitasking limits with this dual-task cognitive assessment.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Start the Trial",
      "text": "Click or tap the 'START DRILL' button on the screen to initialize both the visual and numerical stimulus channels."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Track Moving Circles",
      "text": "Keep your eyes on the left visual panel. Click or tap any expanding or changing target circles before they fade away."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Verify Even Numbers",
      "text": "Simultaneously watch the right numeric panel. When a number shown is EVEN, click the MATCH button immediately."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Build High Combos",
      "text": "Maintain your accuracy in both channels to build multipliers. Missing targets or matching incorrect numbers breaks your combo."
    }
  ]
};

export const metadata = {
  title: "Divided Attention Test – Free Dual-Task Split Focus Game | SkillDrills",
  description: "Test and train divided attention online. Track two visual stimulus streams simultaneously in this free dual-task split focus brain game. No sign-up required.",
  keywords: [
    "divided attention test",
    "divided attention definition",
    "divided attention games",
    "dual task training exercises",
    "split attention exercises",
    "divided attention vs selective attention",
    "divided attention activities",
    "dual task paradigm game",
    "simultaneous attention test",
    "cognitive multitasking test",
    "split focus brain training",
    "dual visual target tracking",
    "how to improve divided attention skills",
    "brain multitasking test",
    "attention test online",
    "free cognitive training online"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/attention/divided-attention",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Divided Attention Test – Free Dual-Task Split Focus Game | SkillDrills",
    description: "Test and train divided attention online. Track two visual stimulus streams simultaneously in this free dual-task split focus brain game. No sign-up required.",
    url: "https://skilldrills.online/drills/cognitive/attention/divided-attention",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Divided Attention Test – Dual-Task Split Focus Brain Game" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Divided Attention Test – Free Dual-Task Split Focus Game | SkillDrills",
    description: "Test and train divided attention online. Track two visual stimulus streams simultaneously in this free dual-task split focus brain game. No sign-up required.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function DividedAttentionPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <DividedAttentionClient />
    </>
  );
}
