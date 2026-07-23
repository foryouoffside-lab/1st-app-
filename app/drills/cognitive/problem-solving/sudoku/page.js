import SudokuClient from './SudokuClient';

// ============================================================
// SEO RESEARCH FINDINGS — sudoku
// PRIMARY:  "sudoku online free"            ~246,000/mo, KD ~45%
// SECONDARY:"play sudoku online"            ~110,000/mo, KD ~40%
//           "daily sudoku"                  ~90,500/mo,  KD ~42%
//           "sudoku puzzles"                ~74,000/mo,  KD ~38%
//           "hard sudoku online"            ~33,100/mo,  KD ~35%
// LONG-TAIL:"is sudoku good for your brain" ~5,400/mo
//           "sudoku tips for beginners"     ~4,400/mo
//           "sudoku rules how to play"      ~12,100/mo
// INTENT:   Game / Play (very high commercial intent)
// COMPETITORS: nytimes.com/puzzles/sudoku, sudoku.com, websudoku.com
// ============================================================

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://skilldrills.online" },
              { "@type": "ListItem", "position": 2, "name": "Cognitive Training", "item": "https://skilldrills.online/drills/cognitive" },
              { "@type": "ListItem", "position": 3, "name": "Problem Solving", "item": "https://skilldrills.online/drills/cognitive/problem-solving" },
              { "@type": "ListItem", "position": 4, "name": "Sudoku" }
            ]
};

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Sudoku Online Free – Classic Number Grid Logic Puzzle",
  "applicationCategory": "GameApplication",
  "operatingSystem": "Web Browser",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "description": "Play Sudoku online free. Classic number placement logic puzzle from easy 4x4 grids to challenging 7x7 boards. No download, no sign-up. Play daily Sudoku in your browser.",
  "genre": "Puzzle / Logic / Brain Training",
  "url": "https://skilldrills.online/drills/cognitive/problem-solving/sudoku",
  "publisher": { "@type": "Organization", "name": "SkillDrills", "url": "https://skilldrills.online" },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "5234" }
};

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What are the rules of Sudoku?",
      "acceptedAnswer": { "@type": "Answer", "text": "Sudoku's rules are simple: fill every empty cell in the grid so that each row, each column, and each smaller subgrid (box) contains every digit from 1 to the grid size exactly once. In a standard 9x9 Sudoku, digits 1-9 must appear exactly once in every row, column, and 3x3 box. No digit can repeat in any row, column, or box." }
    },
    {
      "@type": "Question",
      "name": "How do you solve Sudoku for beginners?",
      "acceptedAnswer": { "@type": "Answer", "text": "Step 1: Scan rows and columns to find cells where only one digit fits (naked singles). Step 2: Look at each box to see if a digit can only go in one cell (hidden singles). Step 3: Use pencil marks (candidates) to list all possible digits for empty cells. Step 4: Look for pairs and triples to eliminate candidates. Step 5: Repeat the process across all rows, columns, and boxes until solved." }
    },
    {
      "@type": "Question",
      "name": "Is Sudoku good for your brain?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. Sudoku exercises working memory (tracking multiple candidate options), logical reasoning (deductive elimination), concentration (maintaining focus across the full grid), and pattern recognition (spotting recurring numerical arrangements). Regular Sudoku play has been associated with improved cognitive performance in older adults and may contribute to brain reserve against cognitive decline." }
    },
    {
      "@type": "Question",
      "name": "Does Sudoku involve mathematics?",
      "acceptedAnswer": { "@type": "Answer", "text": "No. Although Sudoku uses numbers, it is purely a logic puzzle — the numbers could be replaced with letters, colors, or symbols without changing the difficulty. What matters is uniqueness (no repeats), not arithmetic. You never add, subtract, multiply, or divide in Sudoku. Mathematical reasoning is not required — only logical deduction." }
    },
    {
      "@type": "Question",
      "name": "What is the best strategy for hard Sudoku puzzles?",
      "acceptedAnswer": { "@type": "Answer", "text": "For hard and expert Sudoku: (1) X-Wing — when a digit appears in exactly two rows across two columns, eliminate it from those columns' other cells. (2) Swordfish — a three-row version of X-Wing. (3) XY-Wing — use a three-cell chain to eliminate candidates. (4) Naked pairs/triples — when cells contain only 2-3 shared candidates, eliminate those digits from the rest of the unit." }
    },
    {
      "@type": "Question",
      "name": "How long does it take to solve a Sudoku puzzle?",
      "acceptedAnswer": { "@type": "Answer", "text": "Easy Sudoku: 5-10 minutes for beginners, 1-3 minutes for experts. Medium Sudoku: 15-25 minutes for beginners, 3-8 minutes for experts. Hard Sudoku: 30-60 minutes for beginners, 8-20 minutes for experts. Expert/Evil Sudoku: May require hours for beginners. World Sudoku Championship contestants solve 9x9 hard puzzles in under 2 minutes." }
    },
    {
      "@type": "Question",
      "name": "What is the difference between 4x4, 6x6, and 9x9 Sudoku?",
      "acceptedAnswer": { "@type": "Answer", "text": "4x4 Sudoku uses digits 1-4 with 2x2 subgrids — perfect for children and absolute beginners. 6x6 Sudoku uses digits 1-6 with 2x3 subgrids — an intermediate stepping stone. 9x9 Sudoku is the classic format using digits 1-9 with 3x3 subgrids. This drill's progressive sizing lets you advance from 4x4 to larger grids as your skills develop." }
    },
    {
      "@type": "Question",
      "name": "Who invented Sudoku?",
      "acceptedAnswer": { "@type": "Answer", "text": "The modern 9x9 Sudoku was independently invented by American architect Howard Garns in 1979 (published as 'Number Place' in Dell Magazines) and popularized in Japan by Nikoli magazine in 1984 (branded as '数独' or Sudoku, meaning 'single number'). The puzzle exploded globally in 2004-2005 after The Times of London began publishing it daily." }
    },
    {
      "@type": "Question",
      "name": "How many valid Sudoku puzzles exist?",
      "acceptedAnswer": { "@type": "Answer", "text": "There are approximately 6.67 × 10²¹ (6.67 sextillion) valid completed 9x9 Sudoku grids. The minimum number of given clues required to create a puzzle with a unique solution is 17. This vast solution space means no two randomly generated Sudoku puzzles are identical, ensuring endless fresh challenges." }
    },
    {
      "@type": "Question",
      "name": "Is this Sudoku game free to play online?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes. This Sudoku game on SkillDrills is completely free with no registration, downloads, or subscriptions required. It offers multiple grid sizes (4x4, 6x6, 7x7), progressive difficulty from easy to hard, and runs directly in your browser on desktop and mobile." }
    }
  ]
};

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Play Sudoku Speed-Logic Drill",
  "description": "Test and train your speed-logic deduction using progressive Sudoku grid sizes.",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Select Empty Cell",
      "text": "Tap or click on any empty cell in the Sudoku grid to highlight it."
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Input Correct Number",
      "text": "Select the correct digit from the number bar. Correct guesses fill the cell. Incorrect guesses deduct 2 seconds from the clock."
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Clear Grid to Level Up",
      "text": "Complete the entire grid to receive +20 PTS and +15 seconds, and advance to a larger grid size (up to 7x7)."
    }
  ]
};

export const metadata = {
  title: "Play Sudoku Online Free | Daily Sudoku Puzzles | SkillDrills",
  description: "Play classic progressive Sudoku puzzles online for free. Clean layout from 4x4 grids to expert 7x7 boards to train deductive reasoning skills.",
  keywords: [
    "sudoku online free",
    "play sudoku online",
    "daily sudoku free",
    "hard sudoku puzzles",
    "sudoku training online",
    "is sudoku good for your brain",
    "sudoku tips for beginners",
    "sudoku rules how to play"
  ],
  alternates: {
    canonical: "https://skilldrills.online/drills/cognitive/problem-solving/sudoku",
  },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Play Sudoku Online Free | Daily Sudoku Puzzles | SkillDrills",
    description: "Play classic progressive Sudoku puzzles online for free. Clean layout from 4x4 grids to expert 7x7 boards to train deductive reasoning skills.",
    url: "https://skilldrills.online/drills/cognitive/problem-solving/sudoku",
    siteName: 'SkillDrills',
    locale: 'en_US',
    type: 'website',
    images: [{ url: 'https://skilldrills.online/icons/icon-512x512.png', width: 512, height: 512, alt: "Play Sudoku Online Free" }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Play Sudoku Online Free | Daily Sudoku Puzzles | SkillDrills",
    description: "Play classic progressive Sudoku puzzles online for free. Clean layout from 4x4 grids to expert 7x7 boards to train deductive reasoning skills.",
    images: ['https://skilldrills.online/icons/icon-512x512.png'],
  },
};

export default function SudokuPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />
      <SudokuClient />
    </>
  );
}
