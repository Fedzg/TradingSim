#requires -Version 5.1
param([switch]$ProvaOffline)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$root = $PSScriptRoot
Set-Location -LiteralPath $root
$utf8 = New-Object Text.UTF8Encoding($false)
$private = Join-Path $env:LOCALAPPDATA 'TradingSim'
$remoteDir = '"$HOME/.local/share/tradingsim-secrets"'
$services = [ordered]@{
    alpaca=@('APCA_API_KEY_ID','APCA_API_SECRET_KEY')
    telegram=@('TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID')
    twelve=@('TWELVE_DATA_API_KEY')
    gold=@('GOLDAPI_KEY')
}
$names = @{alpaca='Alpaca Paper';telegram='Telegram';twelve='Twelve Data';gold='goldApi.dev'}
$files = @{APCA_API_KEY_ID='alpaca-key';APCA_API_SECRET_KEY='alpaca-secret';TELEGRAM_BOT_TOKEN='telegram.env';TELEGRAM_CHAT_ID='telegram.env';TWELVE_DATA_API_KEY='monitor.env';GOLDAPI_KEY='monitor.env'}
$labels = @{APCA_API_KEY_ID='Chiave Alpaca Paper';APCA_API_SECRET_KEY='Segreto Alpaca Paper';TELEGRAM_BOT_TOKEN='Token del bot Telegram';TELEGRAM_CHAT_ID='ID chat Telegram';TWELVE_DATA_API_KEY='Chiave Twelve Data';GOLDAPI_KEY='Chiave goldApi.dev'}
$template='https://goldapi.dev/api/v1/price/{metal}/USD'
$script:page=0
$script:board=$false
$script:inputs=@{}
$script:copyKeys=@()

# Windows CommandLineToArgvW quoting. Payloads containing credentials use stdin only.
function Native($exe,[string[]]$argv,[string]$payload) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$exe
    $info.Arguments=(($argv | ForEach-Object { '"'+(($_ -replace '(\\*)"','$1$1\"') -replace '(\\+)$','$1$1')+'"' }) -join ' ')
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $p=[Diagnostics.Process]::Start($info)
    try {
        $out=$p.StandardOutput.ReadToEndAsync()
        $err=$p.StandardError.ReadToEndAsync()
        if ($payload) {
            $bytes=$utf8.GetBytes($payload)
            $p.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
        }
        $p.StandardInput.Close()
        while (!$p.WaitForExit(100)) { [Windows.Forms.Application]::DoEvents() }
        $null=$err.GetAwaiter().GetResult()
        if ($p.ExitCode) { throw "Comando $exe fallito. $script:hint" }
        return $out.GetAwaiter().GetResult().TrimEnd()
    } finally { $p.Dispose() }
}
function ProtectDir($dir) {
    if (!(Test-Path -LiteralPath $dir)) { $null=New-Item -ItemType Directory -Path $dir }
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $dir -AclObject $acl
}
function Remote($cmd,$body) { Native ssh.exe ($script:sshArgs + @($script:target,$cmd)) $body }
function RunRemote($code) { Remote 'sh -se' ($code.Replace("`r","")+"`n") }
function LocalDir {

    if ($script:mount -match '^/(?:run/desktop/mnt/host|host_mnt|mnt)/([a-zA-Z])/(.*)$') {return (Split-Path ($matches[1]+':\'+$matches[2].Replace('/','\')))}
    if ($script:mount -match '^[A-Za-z]:') {return Split-Path $script:mount}
    if ($env:TRADINGSIM_SECRETS_DIR -and (Test-Path -LiteralPath $env:TRADINGSIM_SECRETS_DIR)) {return (Resolve-Path -LiteralPath $env:TRADINGSIM_SECRETS_DIR).Path}
    return $null
}
function FindWorker {
    $script:hint='Avvia Docker Desktop con container Linux.'
    $ids=@((Native docker @('ps','--filter','label=com.docker.compose.service=worker','--format','{{.ID}}')) -split '\r?\n' | Where-Object {$_})
    $matchesWorker=@(foreach ($id in $ids) {
        $mount=Native docker @('inspect','-f','{{range .Mounts}}{{if eq .Destination "/run/secrets/alpaca-key"}}{{.Source}}{{end}}{{end}}',$id)
        if ($mount) {[pscustomobject]@{Id=$id;Mount=$mount}}
    })
    if ($matchesWorker.Count -gt 1) {throw 'Sono presenti più worker con credenziali Alpaca. Controllare Docker Desktop.'}
    if ($matchesWorker.Count -eq 0) {return}
    $script:worker=$matchesWorker[0].Id
    $script:mount=$matchesWorker[0].Mount
    $script:project=Native docker @('inspect','-f','{{index .Config.Labels "com.docker.compose.project"}}',$worker)
}
function Connect {
    $script:worker=$null; $script:mount=''; $script:localDir=$null
    if (!$board) { FindWorker } else { try {FindWorker} catch {} }
    $script:localDir=LocalDir
    if (!$board) {
        if (!$worker) {throw 'Worker Windows attivo non trovato. Controllare il contesto Docker Desktop.'}
        if (!$localDir -or !(Test-Path -LiteralPath (Join-Path $localDir 'alpaca-key'))) {
            $pick=New-Object Windows.Forms.FolderBrowserDialog
            $pick.Description='Seleziona la cartella privata che contiene alpaca-key e telegram.env'
            if ($pick.ShowDialog() -ne 'OK') {throw 'Cartella privata necessaria.'}
            $script:localDir=$pick.SelectedPath
        }
        if ([IO.Path]::GetFullPath($localDir).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or $localDir -eq $root) {throw 'Scegli una cartella privata esterna al repository.'}
        $env:TRADINGSIM_SECRETS_DIR=$localDir
        $script:systemInfo="Progetto Docker $project, worker $worker."
        return
    }
    $hostName=$hostBox.Text.Trim(); $user=$userBox.Text.Trim()
    if ($hostName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or $user -notmatch '^[a-z_][a-z0-9_-]*$') {throw 'Inserisci un indirizzo IPv4 o nome host e un utente Linux validi.'}
    ProtectDir $private
    $script:target="$user@$hostName"
    $known=Join-Path $private ("ssh-"+$hostName)
    if (!(Test-Path -LiteralPath $known)) {
        $script:hint='Controllare indirizzo, rete e server OpenSSH sulla scheda.'
        $key=Native ssh-keyscan.exe @('-T','6','-t','ed25519',$hostName)
        if ($key -notmatch ('^'+[regex]::Escape($hostName)+' ssh-ed25519 [A-Za-z0-9+/=]+$')) {throw 'Chiave host Ed25519 non verificabile.'}
        $fp=Native ssh-keygen.exe @('-lf','-') ($key+"`n")
        if ([Windows.Forms.MessageBox]::Show("Confronta questa impronta con quella della console locale della scheda (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub).`n`n$fp`n`nLe impronte coincidono?",'Identità SSH','YesNo') -ne 'Yes') {throw 'Identità non confermata.'}
        [IO.File]::WriteAllText($known,$key+"`n",$utf8)
    }
    $script:sshArgs=@('-o','StrictHostKeyChecking=yes','-o',("UserKnownHostsFile="+$known),'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ForwardAgent=no')
    $script:hint='Verifica la chiave host e abilita sul dispositivo un accesso OpenSSH con chiave per questo utente.'
    $script:systemInfo=RunRemote @'
test "$(uname -s)" = Linux
. /etc/os-release
printf 'Sistema %s | architettura %s\n' "$PRETTY_NAME" "$(uname -m)"
df -h "$HOME" | tail -1
'@
    $script:hint='Installare Docker Engine e il plugin Docker Compose v2.24+ per il sistema rilevato, quindi autorizzare questo utente a Docker. '+$systemInfo
    $version=RunRemote 'docker info >/dev/null; command -v tar >/dev/null; docker compose version --short'
    if ($version -notmatch 'v?(\d+\.\d+\.\d+)' -or [version]$matches[1] -lt [version]'2.24.0') {throw $script:hint}
    $free=RunRemote 'df -Pk "$HOME" | tail -1 | awk ''{print $4}'''
    if ($free -notmatch '^\d+$' -or [long]$free -lt 1048576) {throw 'Meno di 1 GiB disponibile nella home della scheda. Liberare spazio prima della compilazione.'}
    $script:systemInfo+="`nDocker e Compose disponibili."
}
function LocalValue($key) {
    if (!$localDir) {return ''}
    $path=Join-Path $localDir $files[$key]
    if (!(Test-Path -LiteralPath $path)) {return ''}
    $content=[IO.File]::ReadAllText($path)
    if ($files[$key] -notlike '*.env') {return $content.Trim()}
    foreach ($line in ($content -split '\r?\n')) {
        if ($line -match ("^"+$key+"=(.+)$")) {return $matches[1].Trim().Trim('"').Trim("'")}
    }
    return ''
}
function Present($key) {
    if (!$board) {return [bool](LocalValue $key)}
    $f=$remoteDir+'/'+$files[$key]
    $check=if ($files[$key] -like '*.env') {"grep -q '^$key=.' $f"} else {"test -s $f"}
    return (Remote "if $check; then echo yes; else echo no; fi") -eq 'yes'
}
function WriteValue($key,$value) {
    if ($value -notmatch '^[a-zA-Z0-9:._/+=@{}-]+$') {throw "Formato non valido per $key."}
    $filename=if ($key -in @('GOLDAPI_URL_TEMPLATE','GOLDAPI_AUTH_HEADER')) {'monitor.env'} else {$files[$key]}
    $dotenv=$filename -like '*.env'
    $line=if ($dotenv) {"$key=$value"} else {$value}
    if ($board) {
        $file=$remoteDir+'/'+$filename
        $cmd='set -eu; umask 077; mkdir -p '+$remoteDir+'; chmod 700 '+$remoteDir+'; test ! -L '+$file+'; '
        # Keep unrelated settings and atomically replace the selected field.
        $cmd+='tmp=$(mktemp '+$remoteDir+'/part.XXXXXX); trap ''rm -f "$tmp"'' EXIT; '
        if ($dotenv) {$cmd+="if test -f $file; then sed '/^$key=/d' $file > "+'"$tmp"; fi; '}
        $null=Remote ($cmd+'cat >> "$tmp"; mv "$tmp" '+$file) ($line+"`n")
    } else {
        $path=Join-Path $localDir $filename
        $lines=@()
        if ($dotenv -and (Test-Path -LiteralPath $path)) {$lines=@([IO.File]::ReadAllLines($path) | Where-Object {$_ -notmatch ("^"+$key+"=")})}
        $temp=Join-Path $localDir ([guid]::NewGuid().ToString())
        try {
            if (Test-Path -LiteralPath (Join-Path $localDir "alpaca-key")) {
                [IO.File]::WriteAllText($temp,"",$utf8)
                Set-Acl -LiteralPath $temp -AclObject (Get-Acl -LiteralPath (Join-Path $localDir "alpaca-key"))
            }
            [IO.File]::WriteAllLines($temp,[string[]]($lines+@($line)),$utf8)
            if ([IO.File]::Exists($path)) {[IO.File]::Replace($temp,$path,$temp+".bak"); [IO.File]::Delete($temp+".bak")} else {[IO.File]::Move($temp,$path)}
        } finally {if (Test-Path -LiteralPath $temp) {Remove-Item -LiteralPath $temp}}
    }
}
function Verify {
    $script:hint='Verificare Git, spazio disponibile e accesso ai registri dei pacchetti per questa piattaforma.'
    $rev=Native git @('rev-parse','--short=12','HEAD')
    if ($rev -notmatch '^[0-9a-f]{7,12}$') {throw 'Checkout Git non riconosciuto.'}
    $script:image="tradingsim:prepara-$rev"
    $script:compose=@('compose','-p',$project,'-f',(Join-Path $root 'deploy/compose.yaml'))
    if ($board) {
        $script:stage='"$HOME/.local/share/tradingsim-build/'+$rev+'"'
        $arc=Join-Path ([IO.Path]::GetTempPath()) ("tradingsim-"+[guid]::NewGuid()+'.tar.gz')
        try {
            $null=Native git @('archive','--format=tar.gz',("--output="+$arc),'HEAD','package.json','deploy/Dockerfile','src','tests')
            $null=RunRemote ('umask 077; mkdir -p '+$stage)
            $null=Native scp.exe ($sshArgs+@($arc,($target+':.local/share/tradingsim-build/'+$rev+'/source.tar.gz')))
            $null=RunRemote ('cd '+$stage+'; tar xzf source.tar.gz; docker build -f deploy/Dockerfile -t '+$image+' .')
        } finally {if (Test-Path $arc) {Remove-Item -LiteralPath $arc}}
    } else {
        $null=Native docker @('build','-f','deploy/Dockerfile','-t',$image,'.')
    }
    $script:hint='Verifica offline fallita: controllare compatibilità della piattaforma, spazio e dipendenze Bun/Codex/Alpaca MCP.'
    $probe='bun --version && codex --version && alpaca-mcp-server --version && bun test'
    if ($board) {
        $null=RunRemote ('cd '+$stage+'; docker run --rm --network none -v "$PWD/tests:/app/tests:ro" --entrypoint sh '+$image+" -c '$probe'")
    } else {
        $null=Native docker @('run','--rm','--network','none','-v',((Join-Path $root 'tests')+':/app/tests:ro'),'--entrypoint','sh',$image,'-c',$probe)
    }
    $script:hint='Controllo di sola lettura fallito. Verificare rete HTTPS e disponibilità dei provider.'
    $common=@('-e','ALPACA_PAPER_TRADE=true','-e','APCA_API_KEY_ID_FILE=/run/secrets/alpaca-key','-e','APCA_API_SECRET_KEY_FILE=/run/secrets/alpaca-secret')
    if ($board) {
        $json=RunRemote ('cd '+$remoteDir+'; docker run --rm --tmpfs /var/lib/tradingsim -v tradingsim-preparazione-provider:/var/lib/tradingsim/state/providers -v "$PWD:/run/secrets:ro" --env-file telegram.env --env-file monitor.env '+($common -join ' ')+" $image monitor-check --setup")
    } else {
        $stateVolume=$project+'_state'
        $activeVolume=Native docker @('inspect','-f','{{range .Mounts}}{{if eq .Destination "/var/lib/tradingsim"}}{{.Name}}{{end}}{{end}}',$worker)
        if ($activeVolume -ne $stateVolume) {throw 'Volume operativo inatteso.'}
        $null=Native docker @('run','--rm','--network','none','-v',($stateVolume+':/data'),'--entrypoint','mkdir',$image,'-p','/data/state/providers')
        $quotaMount="type=volume,src=$stateVolume,dst=/var/lib/tradingsim/state/providers,volume-subpath=state/providers"
        $json=Native docker (@('run','--mount',$quotaMount,'--rm','--tmpfs','/var/lib/tradingsim','-v',($localDir+':/run/secrets:ro'),'--env-file',(Join-Path $localDir 'telegram.env'),'--env-file',(Join-Path $localDir 'monitor.env'))+$common+@($image,'monitor-check','--setup'))
    }
    return (($json -split '\r?\n')[-1] | ConvertFrom-Json)
}
function UpdatePC {
    $script:hint='Il worker deve essere lo stesso verificato e libero tra le sveglie.'
    $selected=$worker
    FindWorker
    if ($selected -ne $worker) {throw 'È cambiato il worker selezionato.'}
    $mounts=(Native docker @('inspect','-f','{{json .Mounts}}',$worker)) | ConvertFrom-Json
    foreach ($m in @(@('/var/lib/tradingsim','state'),@('/home/tradingsim-agent/.codex','codex'))) {
        if (!($mounts | Where-Object {$_.Destination -eq $m[0] -and $_.Name -eq ($project+'_'+$m[1])})) {throw 'Volume persistente inatteso: controllare il progetto prima di aggiornare.'}
    }
    $rome=[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow,'W. Europe Standard Time')
    foreach ($slot in '09:00','12:30','15:40','18:30','21:40') {
        if ([math]::Abs(($rome.TimeOfDay-[TimeSpan]::Parse($slot)).TotalMinutes) -lt 5) {throw 'Sveglia imminente o appena avviata. Riprovare tra le sveglie.'}
    }
    foreach ($setting in 'TRADINGSIM_CODEX_MODEL','TRADINGSIM_CODEX_MODEL_SCAN','TRADINGSIM_NEWS_SECONDS') {
        $value=Native docker @('exec',$worker,'printenv',$setting)
        [Environment]::SetEnvironmentVariable($setting,$value,'Process')
    }
    $old=Native docker @('inspect','-f','{{.Image}}',$worker)
    $name=Native docker @('inspect','-f','{{.Config.Image}}',$worker)
    $null=Native docker @('tag',$old,($project+':rollback-guidato'))
    $null=Native docker @('exec',$worker,'sh','-ec','cd /var/lib/tradingsim/state; test ! -e run.lock; for g in run orders gold; do flock -n "$g.guard" true; done')
    $null=Native docker @('tag',$image,$name)
    try {
        $null=Native docker ($compose+@('up','-d','--no-build','--force-recreate','worker'))
        $id=Native docker ($compose+@('ps','-q','--status','running','worker'))
        if ($id -notmatch '^[a-f0-9]+$') {throw 'Worker non avviato.'}
        if ((Native docker @('inspect','-f','{{.Image}}',$id)) -ne (Native docker @('image','inspect','-f','{{.Id}}',$image))) {throw 'Immagine inattesa.'}
    } catch {
        $null=Native docker @('tag',$old,$name)
        $null=Native docker ($compose+@('up','-d','--no-build','--force-recreate','worker'))
        throw 'Aggiornamento fallito. Ripristinata immagine precedente.'
    }
}
$form=New-Object Windows.Forms.Form
$form.Text='TradingSim · configurazione guidata'
$form.ClientSize=New-Object Drawing.Size(690,640)
$form.StartPosition='CenterScreen'
$panel=New-Object Windows.Forms.FlowLayoutPanel
$panel.Dock='Fill'; $panel.FlowDirection='TopDown'; $panel.WrapContents=$false; $panel.AutoScroll=$true
$panel.Padding=New-Object Windows.Forms.Padding(18)
$form.Controls.Add($panel)
function Label($text) {
    $c=New-Object Windows.Forms.Label
    $c.AutoSize=$true; $c.MaximumSize=New-Object Drawing.Size(625,0); $c.Text=$text
    $panel.Controls.Add($c)
}
function Box($secret=$false) {
    $c=New-Object Windows.Forms.TextBox
    $c.Width=460; $c.UseSystemPasswordChar=$secret; $panel.Controls.Add($c)
    return $c
}
function Button($text,$action) {
    $c=New-Object Windows.Forms.Button
    $c.AutoSize=$true; $c.Text=$text
    $c.Tag=$action
    $c.Add_Click({
        param($sender,$eventArgs)
        $panel.Enabled=$false
        try { $handler=$sender.Tag; & $handler } catch { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'TradingSim') }
        finally {$panel.Enabled=$true}
    })
    $panel.Controls.Add($c)
}
function Draw {
    $panel.Controls.Clear()
    Label ('Connessione → Credenziali → Verifica → Riepilogo')
    switch ($script:page) {
        0 {
            Label 'Connessione'
            $script:route=New-Object Windows.Forms.ComboBox
            $route.DropDownStyle='DropDownList'; $route.Width=440
            $route.Items.AddRange(@('Aggiorna il worker sul PC Windows','Prepara TradingSim sulla KICKPI K2B'))
            $route.SelectedIndex=[int]$board; $panel.Controls.Add($route)
            $route.Add_SelectedIndexChanged({$script:board=$route.SelectedIndex -eq 1; Draw})
            if ($board) {Label 'Indirizzo IP o nome della scheda'; $script:hostBox=Box; Label 'Utente SSH'; $script:userBox=Box}
            Button 'Connetti' { Connect; $script:page=1; Draw }
        }
        1 {
            Label $systemInfo
            $script:inputs=@{}; $script:copyKeys=@()
            foreach ($svc in $services.Keys) {
                $missing=@($services[$svc] | Where-Object {!(Present $_) -or ($script:result -and !$script:result.$svc)})
                if (!$missing.Count) {Label ($names[$svc]+' · Già configurato'); continue}
                Label ($names[$svc]+$(if ($script:result -and !$script:result.$svc) {' · Verifica fallita'} else {' · Da inserire'}))
                foreach ($key in $missing) {
                    if ($board -and (LocalValue $key)) {$script:copyKeys+=$key; Label ($labels[$key]+' · copia protetta disponibile dal PC')}
                    else {Label $labels[$key]; $inputs[$key]=Box $true}
                }
            }
            if ($copyKeys.Count) {
                $script:consent=New-Object Windows.Forms.CheckBox
                $consent.Text='Autorizzo il trasferimento via SSH dei campi elencati'; $consent.AutoSize=$true; $panel.Controls.Add($consent)
            }
            Label "Gold: $template · X-API-Key"
            Button 'Salva e continua' {
                if ($copyKeys.Count -and !$consent.Checked) {throw 'Conferma il trasferimento dei campi elencati.'}
                foreach ($key in $inputs.Keys) {if (!$inputs[$key].Text.Trim()) {throw ('Compila '+$labels[$key])}}
                foreach ($key in $copyKeys) {WriteValue $key (LocalValue $key)}
                foreach ($key in $inputs.Keys) {WriteValue $key $inputs[$key].Text.Trim(); $inputs[$key].Clear()}
                WriteValue GOLDAPI_URL_TEMPLATE $template
                WriteValue GOLDAPI_AUTH_HEADER 'X-API-Key'
                $script:page=2; Draw
            }
        }
        2 {
            Label 'Verifica · prima suite offline senza rete, poi letture dirette dei provider in un container temporaneo. La compilazione sulla scheda può richiedere alcuni minuti.'
            Button 'Verifica' {$script:result=Verify; $script:page=3; Draw}
        }
        3 {
            Label $systemInfo
            $passed=$true
            foreach ($svc in $services.Keys) {
                if ($result.$svc -is [bool] -and $result.$svc) {Label ($names[$svc]+' · Già configurato · lettura riuscita')}
                else {Label ($names[$svc]+' · Verifica fallita'); $passed=$false}
            }
            if ($board) {
                Label 'Preparazione sulla scheda. Il passaggio di servizio e la migrazione dei volumi richiedono una procedura successiva.'
                Button 'Login ufficiale Codex sulla scheda' {
                    $cmd='docker run --rm -it --user 10001:10001 -v tradingsim_codex:/home/tradingsim-agent/.codex --entrypoint codex '+$image+' login --device-auth'
                    & ssh.exe @sshArgs -t $target $cmd
                }
            } elseif ($passed) {
                Button 'Applica aggiornamento al worker Windows' {UpdatePC; $panel.Controls.Clear(); Label 'Aggiornamento completato. Un worker attivo con la nuova immagine.'}
            }
            if (!$passed) {Button 'Correggi credenziali' {$script:page=1; Draw}}
        }
    }
}
$form.Add_FormClosing({param($sender,$eventArgs) if (!$panel.Enabled) {$eventArgs.Cancel=$true}})
Draw
if ($ProvaOffline) {
    # Run WinForms layout and navigation on Windows with disposable fake provider outcomes.
    $form.Show()
    foreach ($mode in $false,$true) {
        $script:board=$mode; $script:page=0; Draw
        if (($panel.Controls | Where-Object {$_ -is [Windows.Forms.TextBox]}).Count -ne (2*[int]$mode)) {throw 'Campi connessione errati'}
        function Present($key) {return !$board -and $key -notin @('TWELVE_DATA_API_KEY','GOLDAPI_KEY')}
        function LocalValue($key) {return ''}
        $script:result=$null; $script:systemInfo='Dispositivo fittizio'
        $script:page=1; Draw
        if ($inputs.Count -ne $(if ($mode) {6} else {2})) {throw 'Campi credenziali errati'}
        foreach ($box in $inputs.Values) {if (!$box.UseSystemPasswordChar) {throw 'Campo visibile'}}
        $script:page=2; Draw
        $script:result=[pscustomobject]@{alpaca=$true;telegram=$true;twelve=$true;gold=$false}
        $script:page=3; Draw
        if (!($panel.Controls | Where-Object {$_.Text -like '*Verifica fallita*'})) {throw 'Esito mancante'}
        [Windows.Forms.Application]::DoEvents()
    }
    $form.Close()
    Write-Output 'Percorsi Windows e KICKPI verificati con dati fittizi.'
} else { [void]$form.ShowDialog() }
