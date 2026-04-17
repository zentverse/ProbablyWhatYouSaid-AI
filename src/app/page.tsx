import TranscriberClient from "@/components/TranscriberClient";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-10rem] top-[-6rem] h-[24rem] w-[24rem] rounded-full bg-cyan-300/10 blur-[140px]" />
        <div className="absolute right-[-8rem] top-12 h-[28rem] w-[28rem] rounded-full bg-white/6 blur-[160px]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),transparent_22%,transparent_78%,rgba(255,255,255,0.02))]" />
      </div>

      <div className="relative z-10 flex min-h-screen w-full items-center py-10">
        <TranscriberClient />
      </div>
    </main>
  );
}
