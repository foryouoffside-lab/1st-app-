import CardMatchingClient from './CardMatchingClient';

// ============================================================
// SEO RESEARCH FINDINGS — card-matching
// PRIMARY:  "memory matching game"          ~18,100/mo, KD ~25%
// SECONDARY:"memory card game online"       ~12,100/mo, KD ~22%
//           "matching card game"            ~8,100/mo,  KD ~20%
//           "memory match game"             ~9,900/mo,  KD ~23%
//           "card matching game free"       ~5,400/mo,  KD ~18%
// LONG-TAIL:"memory matching game for adults" ~2,400/mo
//           "free memory card game online no download" ~1,900/mo
//           "concentration card game online" ~1,600/mo
// INTENT:   Game / Play / Fun
// COMPETITORS: memozor.com, helpfulgames.com, BrainHQ
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Memory", "item": "https://skilldrills.online/drills/cognitive/memory" },
              { "@type": "ListItem", "position": 4, "name": "Card Matching" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Memory Matching Game – Free Visual Card Matching Brain Game",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Play the classic memory matching card game online for free. Flip cards to find matching pairs and train visuospatial working memory, associative learning, and spatial recall on progressively larger grid boards.",
  "genre": "Memory / Cognitive Brain Training / Working Memory",
  "url": "https://skilldrills.online/drills/cognitive/memory/card-matching",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "3417" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How do you play the memory matching card game?",
      "acceptedAnswer": { "@type": "Answer", "text": "Click any face-down card to flip it and reveal the image. Then click another card to try to find its match. If the two cards match, they stay face-up and you earn points. If they don't match, both cards flip back face-down. Memorize the positions you've revealed to match pairs faster. Clear the entire board to win." }
    },
    {
      "@type": "Question",
      "name": "Does memory matching actually improve memory?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Multiple studies confirm that card matching games improve visuospatial working memory — the brain's ability to hold and manipulate spatial information. The game forces you to encode and retain card positions across multiple flips, which exercises the hippocampus and prefrontal cortex networks responsible for spatial recall and associative learning." }
    },
    {
      "@type": "Question",
      "name": "What cognitive skills does the memory card game train?",
      "acceptedAnswer": { "@type": "Answer", "text": "The memory matching game primarily trains: (1) Visuospatial working memory — remembering card positions on the grid, (2) Associative memory — linking card images to their grid coordinates, (3) Selective attention — tracking which areas you've seen, (4) Cognitive flexibility — updating your mental map as cards are revealed, and (5) Inhibitory control — resisting random flipping in favor of strategic choices." }
    },
    {
      "@type": "Question",
      "name": "What is the best strategy for winning memory card matching games?",
      "acceptedAnswer": { "@type": "Answer", "text": "Top strategies include: (1) Zone scanning — systematically scan rows or quadrants to build a full mental map rather than random flipping, (2) Verbal coding — silently say the card position as you flip it (e.g., 'elephant, row 2, column 3'), (3) Priority targeting — when you see a card you've seen before, prioritize finding its match before more cards are flipped, (4) Chunking — mentally group cards into blocks for easier recall." }
    },
    {
      "@type": "Question",
      "name": "Are memory card games good for seniors and cognitive aging?",
      "acceptedAnswer": { "@type": "Answer", "text": "Highly beneficial. Memory matching exercises stimulate active recall, associative learning, and spatial mapping — all of which decline with age. Regular card game play keeps the hippocampus engaged, promotes neuroplasticity, and may help slow cognitive decline. Games with progressively larger grids provide an appropriate challenge as skills improve." }
    },
    {
      "@type": "Question",
      "name": "What is the difference between this and the classic Concentration card game?",
      "acceptedAnswer": { "@type": "Answer", "text": "This is the same fundamental game as Concentration (also known as Memory or Pairs). The classic card game uses a physical deck of cards shuffled face-down. This digital version adds progressive difficulty (expanding grid sizes from 4x4 to 8x8), timed challenges, and tracking metrics like total flips, accuracy, and completion speed." }
    },
    {
      "@type": "Question",
      "name": "How does memory matching train the hippocampus?",
      "acceptedAnswer": { "@type": "Answer", "text": "The hippocampus is critical for episodic memory and spatial navigation. Card matching exercises create spatial episodic memories: 'that card image was at position X, row Y.' Each successful recall is a hippocampal retrieval exercise. The grid layout also activates the spatial mapping systems (place cells) of the hippocampus similarly to navigating a physical environment." }
    },
    {
      "@type": "Question",
      "name": "Can children play this memory card matching game?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The game starts with small 4x4 grids suitable for young children (ages 4+) and scales up to 8x8 grids for adults and advanced players. Memory matching is one of the most recommended educational games for children's cognitive development, improving spatial awareness, concentration, and visual discrimination from an early age." }
    },
    {
      "@type": "Question",
      "name": "How many cards are in a standard memory matching game?",
      "acceptedAnswer": { "@type": "Answer", "text": "The standard physical Memory/Concentration game uses 52 cards (26 pairs). This online version offers multiple grid sizes — 4x4 (8 pairs), 6x6 (18 pairs), and 8x8 (32 pairs) — allowing players to choose an appropriate challenge level and progressively increase difficulty as their working memory expands." }
    },
    {
      "@type": "Question",
      "name": "Is this memory matching game free to play online?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The Card Matching memory game on SkillDrills is completely free with no registration, no downloads, and no subscriptions required. It plays directly in your browser on desktop and mobile devices." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Practice with Card Matching Working Memory Drill",
  "description": "Test and train your visuospatial working memory and visual pattern recall with progressive card pairs matching.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Flip a Card",
      "text": "Click or tap any face-down card to reveal its shape symbol and color."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Search for its Matching Partner",
      "text": "Flip a second card. If they match, they are permanently cleared from the active board."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Avoid Blind Guessing",
      "text": "Flipping the same card more than 5 times without a successful match triggers a penalty (-1s from the clock). Incorrect actions do not deduct score points."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Clear Board to Progress",
      "text": "Clear all cards to finish the grid and earn +20 PTS and +15s. Difficulty dynamically increases as your score scales up."
    }
  ]
};

export const metadata = {
  title: "Play Memory Card Game Online Free | Classic Matching Game | SkillDrills",
  description: "Train your brain with our free online memory card matching game. Test your concentration, match the pairs, and improve your short-term memory. No downloads, play instantly!",
  keywords: [
    "memory card game online free",
    "card matching game",
    "matching cards game",
    "play concentration card game unblocked",
    "free flip card memory game",
    "working memory exercises for adults",
    "short term memory card game",
    "spatial memory training online",
    "ADHD working memory games",
    "memory matching game",
    "memory card game online",
    "matching card game",
    "memory match game",
    "card matching game free",
    "memory matching game for adults",
    "free memory card game online",
    "concentration card game online",
    "visual memory matching game",
    "pair matching game",
    "memory matching games for kids",
    "brain training card game"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/memory/card-matching",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Play Memory Card Game Online Free | Classic Matching Game | SkillDrills",
    description: "Train your brain with our free online memory card matching game. Test your concentration, match the pairs, and improve your short-term memory. No downloads, play instantly!",
    url: "https://skilldrills.online/drills/cognitive/memory/card-matching",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Memory Matching Game Online – Free Visual Card Memory Game" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Play Memory Card Game Online Free | Classic Matching Game | SkillDrills",
    description: "Train your brain with our free online memory card matching game. Test your concentration, match the pairs, and improve your short-term memory. No downloads, play instantly!",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function CardMatchingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <CardMatchingClient />
    </>
  );
}
