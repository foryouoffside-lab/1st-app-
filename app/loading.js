// Route-transition fallback — what shows in the gap between navigating and the
// next screen being ready, including on the way OUT of a category or drill,
// which is where it was most noticeable.
//
// It used to be light-themed (bg-gray-50, blue spinner, grey text) while every
// real screen in this app is near-black, so each navigation punched a bright
// white rectangle onto the display for a fraction of a second. On an OLED phone
// that reads as a fault rather than a loading state. Same palette as the rest of
// the app now, so a transition is simply invisible.
export default function Loading() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-[#050508]"
      role="status"
      aria-label="Loading"
    >
      <div className="text-center">
        <div className="relative w-14 h-14 mx-auto mb-4">
          <div className="absolute inset-0 border-4 border-violet-500/20 rounded-full" />
          <div className="absolute inset-0 border-4 border-violet-500 border-t-transparent rounded-full animate-spin" />
        </div>
        <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px]">
          Loading
        </p>
        <span className="sr-only">Loading SkillDrills. Please wait.</span>
      </div>
    </div>
  );
}
