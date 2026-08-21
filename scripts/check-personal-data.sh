#!/usr/bin/env bash
#
# ¿Hay datos de una persona real en el código?
#
# gitleaks busca credenciales. Esto busca la otra cosa que no va en un
# repositorio público y que ninguna herramienta de secretos mira: el teléfono
# de alguien, su casilla de correo.
#
# Existe porque lo hice yo. Escribí el número personal de Ilan en la
# documentación y en cuatro archivos de test sin registrar que el repo era
# público, y un teléfono no se puede desandar una vez que entró al historial.
#
# Lo que sí puede estar vive en .github/allowed-contacts.txt, cada entrada con
# su motivo. Sin motivo no se agrega: una lista de excepciones sin explicación
# termina siendo el lugar donde se esconden los problemas.

set -uo pipefail

ALLOWLIST=".github/allowed-contacts.txt"
found=0

allowed() {
  # sed, no tr: `tr -d '[:space:]'` borra también los saltos de línea y
  # devuelve la lista entera pegada en una sola cadena, contra la que no
  # coincide nada. El filtro parecía andar y no filtraba nada.
  grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" | sed 's/[[:space:]]//g'
}

scan() {
  local what="$1" pattern="$2" hits
  hits=$(grep -rInE "$pattern" \
    --include='*.ts' --include='*.tsx' --include='*.md' --include='*.yml' \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.crew-workspace \
    . 2>/dev/null || true)

  while IFS= read -r ok; do
    [ -z "$ok" ] && continue
    hits=$(printf '%s\n' "$hits" | grep -vF "$ok" || true)
  done < <(allowed)

  hits=$(printf '%s\n' "$hits" | grep -v '^$' || true)

  if [ -n "$hits" ]; then
    echo "::error::$what"
    printf '%s\n' "$hits"
    found=1
  fi
}

# Teléfonos argentinos y uruguayos con código de país.
scan "Teléfonos que no están en la lista permitida:" \
  '[+]?\b(54|598)9?[0-9]{8,10}\b'

# Casillas de proveedores de correo personales.
scan "Direcciones de correo reales:" \
  '[a-z0-9._%+-]+@(gmail|hotmail|outlook|yahoo|live)\.[a-z]{2,}'

# ── .env.example ─────────────────────────────────────────────────────────────
#
# El archivo donde más fácil se cuela una credencial real: alguien copia su
# .env.local para documentar las variables y se olvida de vaciar los valores.
# gitleaks no lo mira — sus marcadores disparan la regla de entropía y hubo que
# excluirlo — así que lo mira esto.
#
# Busca FORMA DE CREDENCIAL, no "valor largo". La primera versión marcaba
# R2_BUCKET=claim-attachments y GOOGLE_CLOUD_LOCATION=us-central1, que son
# configuración y no secretos; un chequeo así se apaga a la semana.
#
# Lo que sí es sospechoso: una cadena de aspecto aleatorio, una cadena con
# prefijo conocido de proveedor, o una URL con usuario y contraseña adentro.
check_env_example() {
  local file=".env.example" bad="" name value
  [ -f "$file" ] || return 0

  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    name="${line%%=*}"
    value="${line#*=}"
    value="${value%%#*}"
    value="$(printf '%s' "$value" | sed 's/[[:space:]]*$//; s/^["'"'"']//; s/["'"'"']$//')"

    # Un marcador se declara como tal.
    printf '%s' "$value" | grep -qiE '<|placeholder|example|your|tu-|xxx|change[-_]?me|\.\.\.' && continue

    # Prefijos de proveedor: son credenciales por definición.
    if printf '%s' "$value" | grep -qE '^(sk-|AIza|ghp_|gho_|xox[baprs]-|EAA[A-Za-z0-9]|AKIA)'; then
      bad="${bad}  ${name} (prefijo de credencial)"$'\n'
      continue
    fi

    # Una URL con contraseña adentro.
    if printf '%s' "$value" | grep -qE '://[^/[:space:]]+:[^@/[:space:]]+@'; then
      bad="${bad}  ${name} (URL con contraseña)"$'\n'
      continue
    fi

    # Aspecto aleatorio: 24+ caracteres sin separadores de palabra y con
    # mezcla de letras y dígitos. La configuración legible casi nunca es así
    # (claim-attachments, us-central1, gemini-2.0-flash).
    if printf '%s' "$value" | grep -qE '^[A-Za-z0-9+/=_]{24,}$' \
      && printf '%s' "$value" | grep -qE '[0-9]' \
      && printf '%s' "$value" | grep -qE '[A-Za-z]'; then
      bad="${bad}  ${name} (parece una clave)"$'\n'
    fi
  done < "$file"

  if [ -n "$bad" ]; then
    echo "::error::Valores en .env.example que parecen credenciales reales:"
    printf '%s' "$bad"
    echo "Este archivo se lee en un repo público. Poné <tu-clave>."
    found=1
  fi
}

check_env_example

if [ "$found" = "1" ]; then
  echo ""
  echo "Usá 5491100000000 y algo@example.com — no son de nadie."
  echo "Si de verdad tiene que estar, agregalo a $ALLOWLIST con el motivo."
  exit 1
fi

echo "Sin datos personales fuera de la lista permitida."
