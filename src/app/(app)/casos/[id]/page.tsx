/**
 * Case detail page — placeholder. Full implementation in W6.
 */

interface CaseDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { id } = await params;

  return (
    <div className="px-6 py-8">
      <h1 className="text-xl font-semibold text-slate-900">Detalle del caso</h1>
      <p className="mt-2 text-sm text-slate-500 font-mono">{id}</p>
      <p className="mt-4 text-sm text-slate-400">Implementado en W6.</p>
    </div>
  );
}
