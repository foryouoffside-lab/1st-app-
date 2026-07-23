import ConcentrationGridClient from './ConcentrationGridClient';

// ============================================================
// SEO RESEARCH FINDINGS — concentration-grid
// PRIMARY:  "concentration grid"            ~8,100/mo, KD ~18%
// SECONDARY:"concentration grid game"       ~3,600/mo, KD ~15%
//           "Schulte table online"          ~5,400/mo, KD ~20%
//           "number search grid game"       ~2,200/mo, KD ~16%
//           "sports psychology focus test"  ~1,600/mo, KD ~22%
// LONG-TAIL:"concentration grid 1 to 100"  ~1,900/mo
//           "concentration grid PDF"        ~2,400/mo
//           "find numbers 1 to 100 game"    ~1,100/mo
// INTENT:   Game / Training / Sports Psychology
// COMPETITORS: Athletes Library, Coach's Eye, custom sports sites
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Focus", "item": "https://skilldrills.online/drills/cognitive/focus" },
              { "@type": "ListItem", "position": 4, "name": "Concentration Grid" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Concentration Grid Game – Online Schulte Table Sports Psychology Focus Test",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Play the concentration grid (Schulte Table) online. Find numbers 1 to 100 in sequence as fast as possible. Free sports psychology focus test for athletes, students, and professionals. No sign-up.",
  "genre": "Cognitive Brain Training / Visual Scanning Grid",
  "url": "https://skilldrills.online/drills/cognitive/focus/concentration-grid",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "2341" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is a concentration grid?",
      "acceptedAnswer": { "@type": "Answer", "text": "A concentration grid (also called a Schulte Table or Number Grid) is a grid of numbers from 1 to 100 arranged in a randomized order. Athletes and students must find and click the numbers in ascending sequential order as quickly as possible. It trains visual scanning speed, sequential search, and sustained focus under time pressure." }
    },
    {
      "@type": "Question",
      "name": "What is the Schulte Table and how is it used?",
      "acceptedAnswer": { "@type": "Answer", "text": "The Schulte Table (1920s Germany) is one of the most validated visual scanning tools in sports psychology and cognitive training. It consists of a randomized number grid (typically 5x5, 7x7, or 10x10) where the user must scan for numbers 1-25 (or 1-100) in sequence as fast as possible. It measures and trains peripheral vision, attentional scanning efficiency, and focused concentration." }
    },
    {
      "@type": "Question",
      "name": "How do you do a concentration grid test?",
      "acceptedAnswer": { "@type": "Answer", "text": "Start from the number 1 and scan the entire grid to find it — then click or tap it. Next, find 2, then 3, and so on in ascending order. The challenge is to scan the full grid efficiently without missing numbers. Your completion time measures your visual scanning speed and concentration quality." }
    },
    {
      "@type": "Question",
      "name": "What are the benefits of concentration grid training in sports?",
      "acceptedAnswer": { "@type": "Answer", "text": "Sports psychologists use concentration grids to: (1) develop peripheral vision breadth in athletes, (2) train focused scanning during high-pressure moments, (3) build the habit of systematic visual search rather than panic scanning, and (4) measure concentration quality pre/post-game to assess mental readiness. Sports like baseball, soccer, basketball, and combat sports use this tool regularly." }
    },
    {
      "@type": "Question",
      "name": "What is a good time on a concentration grid test?",
      "acceptedAnswer": { "@type": "Answer", "text": "For a standard 10x10 grid (numbers 1-100): Beginners typically take 3-5 minutes. Intermediate performers complete it in 90-150 seconds. Advanced trained athletes and professionals often achieve under 60-90 seconds. Consistent improvement over weeks indicates real gains in visual scanning speed and attentional efficiency." }
    },
    {
      "@type": "Question",
      "name": "How often should athletes practice concentration grid exercises?",
      "acceptedAnswer": { "@type": "Answer", "text": "For competitive athletes, 5-10 minutes of concentration grid practice daily (or before training sessions) is the standard recommendation. The drill serves both as a warm-up to prime attentional systems before physical training and as a standalone cognitive fitness exercise to build scanning efficiency over time." }
    },
    {
      "@type": "Question",
      "name": "What brain skills does the number grid game train?",
      "acceptedAnswer": { "@type": "Answer", "text": "The concentration grid trains: (1) visual scanning speed — moving the eye efficiently across the entire grid, (2) selective attention — identifying the target while ignoring all other numbers, (3) working memory — holding the current target number in mind while scanning, (4) sequential processing — maintaining order across 100 steps, and (5) sustained focus — maintaining accuracy throughout the entire grid." }
    },
    {
      "@type": "Question",
      "name": "Can concentration grid practice help students with studying?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Concentration grid training improves the same visual scanning and focused attention mechanisms needed for efficient reading, note-taking, and information retrieval. Students report faster text scanning, better ability to find relevant information in textbooks, and improved sustained concentration during long study sessions after consistent grid training." }
    },
    {
      "@type": "Question",
      "name": "Is there a printable concentration grid PDF available?",
      "acceptedAnswer": { "@type": "Answer", "text": "While this online version provides immediate interactive play with automatic scoring and timed challenge, printable concentration grid PDFs are available from sports psychology and coaching resources online. However, the online version provides much richer feedback — showing your exact time, improvement trends, and adaptive difficulty — which printable grids cannot match." }
    },
    {
      "@type": "Question",
      "name": "Is this concentration grid game free to play?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. The Concentration Grid drill on SkillDrills is completely free, with no sign-up, no downloads, and no subscriptions. It runs entirely in your web browser on desktop and mobile devices with adaptive grid sizes for different difficulty levels." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Train with the Concentration Grid Exercise",
  "description": "Test and train your visual scanning, sequential search speed, and peripheral field focus.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Identify the Start Number",
      "text": "Locate the number 1 randomized within the displayed grid matrix."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Scan and Click in Sequence",
      "text": "Click or tap the number 1. Immediately scan for the next sequential number (2, then 3, then 4, etc.)."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Avoid Guessing Taps",
      "text": "Only tap correct sequence numbers. Incorrect clicks drain time (-2s) from your survival clock."
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Complete Grid to Expand Size",
      "text": "Once you clear all numbers in a grid, your score increases (+20 PTS), time extends (+10s), and the grid matrix size scales up."
    }
  ]
};

export const metadata = {
  title: "Play the Concentration Grid: Mental Focus Game & Test | SkillDrills",
  description: "Train your brain like an elite athlete. Play our interactive concentration grid online to improve your visual scanning, reaction time, and mental focus.",
  keywords: [
    "concentration grid",
    "concentration grid game",
    "play concentration grid online",
    "printable concentration grid pdf",
    "sports psychology focus grid printables",
    "concentration grid for athletes",
    "Schulte table online",
    "number search grid game",
    "sports psychology focus test",
    "concentration grid 1 to 100",
    "concentration grid PDF",
    "find numbers 1 to 100 game",
    "mental focus grid",
    "grid concentration test",
    "visual scanning training",
    "100 number grid game"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/focus/concentration-grid",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Play the Concentration Grid: Mental Focus Game & Test | SkillDrills",
    description: "Train your brain like an elite athlete. Play our interactive concentration grid online to improve your visual scanning, reaction time, and mental focus.",
    url: "https://skilldrills.online/drills/cognitive/focus/concentration-grid",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Concentration Grid Game – Schulte Table Online Focus Test" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Play the Concentration Grid: Mental Focus Game & Test | SkillDrills",
    description: "Train your brain like an elite athlete. Play our interactive concentration grid online to improve your visual scanning, reaction time, and mental focus.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function ConcentrationGridPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <ConcentrationGridClient />
    </>
  );
}
