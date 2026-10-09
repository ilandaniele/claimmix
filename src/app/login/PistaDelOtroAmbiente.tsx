/**
 * La pista para quien tenía su cuenta en el otro ambiente: el `{url}` del texto
 * se vuelve el enlace. De servidor y sin JavaScript, como la pantalla que la pinta.
 */
export function PistaDelOtroAmbiente({ texto, url, className }: { texto: string; url: string; className?: string }) {
  const [antes, despues] = texto.split("{url}");
  return (
    <p className={className}>
      {antes}
      <a
        href={url}
        className="rounded font-medium text-slate-700 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
      >
        {new URL(url).host}
      </a>
      {despues}
    </p>
  );
}
