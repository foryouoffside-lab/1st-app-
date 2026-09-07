import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050508] px-4">
      <div className="text-center max-w-md">
        <h1 className="text-7xl font-extrabold bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent mb-4">
          404
        </h1>
        <h2 className="text-2xl font-semibold text-white mb-2">Page Not Found</h2>
        <p className="text-white/60 mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.<br />
          Every drill is on the home screen.
        </p>
        <div className="flex justify-center">
          <Link
            href="/"
            className="px-6 py-3 bg-gradient-to-r from-blue-600 to-violet-600 text-white rounded-lg font-semibold hover:shadow-lg transition-all transform hover:scale-[1.02]"
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}
