#!/bin/bash

# Configurazione utente per i commit
git config --global user.name "nomeutente"
git config --global user.email "nomeutente@example.com"

# Aggiungi il remote upstream se non esiste
git remote get-url upstream || git remote add upstream https://github.com/Viren070/AIOStreams.git

# Sincronizziamo il fork con upstream
echo "🔁 Sincronizzando il fork con upstream..."
git fetch upstream

# Backup in zona sicura (fuori dal tracciamento Git)
backup_dir=".git/backup_files"
echo "🛡️ Backup nella cripta di Git: $backup_dir"
mkdir -p "$backup_dir/.github/workflows"

cp update_and_deploy.sh "$backup_dir/update_and_deploy.sh"
cp .github/workflows/* "$backup_dir/.github/workflows/" 2>/dev/null || echo "⚠️ Nessun workflow da copiare"

# Checkout e reset apocalittico
echo "💣 Reset brutale verso upstream/main..."
git checkout main || git checkout -b main
git reset --hard upstream/main

# Ripristino dei sopravvissuti
echo "🧙‍♂️ Ripristino dei file sopravvissuti al massacro..."
cp "$backup_dir/update_and_deploy.sh" update_and_deploy.sh
mkdir -p .github/workflows
cp "$backup_dir/.github/workflows/"* .github/workflows/ 2>/dev/null || echo "⚠️ Nessun workflow da ripristinare"

# Commit della resurrezione
echo "📝 Git add + commit dei file rianimati..."
git add .
git commit -m "Merge forzato da upstream, file locali preservati come reliquie"

# Push tipo schianto in autostrada
echo "📤 Pushando senza pietà..."
git push origin main --force

# Pulizia finale (nemmeno Git deve sapere cosa è successo)
echo "🧼 Pulizia delle tracce... CIAONE!"
rm -rf "$backup_dir"

echo "✅ Fatto. Git aggiornato. I tuoi file? Salvi. Le bestemmie? Evitate... per ora."
