; AdminReminder — instalator Windows.
; Buduje go .github/workflows/windows-installer.yml na runnerze windows-latest,
; po npm run build + node windows/build.mjs (ktory sklada dist\win\app) oraz
; pobraniu node.exe i nssm.exe do tego samego katalogu.
;
; Architektura: NSSM opakowuje "node.exe service-entry.js" jako usluge
; Windows "AdminReminder" - NIE przez PowerShell (usluga ktora w drzewie
; procesow odpala powershell.exe to dokladnie wzorzec ktory ML Defendera
; oznacza jako trojan/persistence; service-entry.js robi to samo co dawniej
; robil PS1, w czystym Node). Przy kazdym starcie wczytuje
; %ProgramData%\AdminReminder\.env do zmiennych srodowiskowych i odpala
; server.js (standalone build Next.js) - ten sam wzorzec co
; docker-entrypoint.sh + docker-compose environment: w wersji LXC.
;
; Kompilacja lokalna (na Windows, z zainstalowanym Inno Setup 6):
;   iscc windows\AdminReminder.iss /DMyAppVersion=0.2.0

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#define MyAppName "AdminReminder"
#define MyAppPublisher "Krzysztof Gawkowski"
#define MyAppURL "https://www.krzysztofgawkowski.pl"

[Setup]
AppId={{68C68359-3B8F-4676-8E09-6ACF4F47D6EB}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\AdminReminder
DefaultGroupName=AdminReminder
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist\installer
OutputBaseFilename=AdminReminder-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile=..\LICENSE
UninstallDisplayIcon={app}\node.exe
; A service install/removal on every run: nothing here is safely resumable
; mid-way, so a silent re-run always redoes the whole post-install sequence.
CloseApplications=no

[Languages]
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; node.exe and nssm.exe are dropped into dist\win\app by the CI workflow
; (windows-installer.yml) after build.mjs runs — not part of the repo, this
; wildcard just needs them to be sitting there at compile time.
Source: "..\dist\win\app\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Otworz AdminReminder"; Filename: "{code:GetAppUrl}"
Name: "{group}\Katalog danych (baza, .env, logi)"; Filename: "{commonappdata}\AdminReminder"
Name: "{group}\Odinstaluj AdminReminder"; Filename: "{uninstallexe}"

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  UpgradePage: TInputOptionWizardPage;

// Existing service or data dir means a previous install is already here —
// silently upgrading in place with no visible choice left people unsure
// whether they'd just lost their database or ended up with two copies.
function DetectExistingInstall: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonappdata}\AdminReminder\.env')) or
    RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\AdminReminder');
end;

function WipeRequested: Boolean;
begin
  Result := (UpgradePage <> nil) and (UpgradePage.SelectedValueIndex = 1);
end;

function GetAppUrl(Param: String): String;
begin
  if ConfigPage <> nil then
    Result := 'http://localhost:' + ConfigPage.Values[0]
  else
    Result := 'http://localhost:3000';
end;

function DefaultAppOrigin: String;
var
  ComputerName: String;
begin
  ComputerName := GetEnv('COMPUTERNAME');
  if ComputerName = '' then ComputerName := 'localhost';
  Result := 'http://' + ComputerName + ':3000';
end;

procedure InitializeWizard;
begin
  if DetectExistingInstall then
  begin
    UpgradePage := CreateInputOptionPage(wpWelcome,
      'Wykryto istniejaca instalacje',
      'AdminReminder jest juz zainstalowany na tym komputerze',
      'Wybierz, co ma zrobic instalator:',
      True, False);
    UpgradePage.Add('Zaktualizuj — zachowaj baze danych, ustawienia i haslo (zalecane)');
    UpgradePage.Add('Zacznij od nowa — usun baze danych, ustawienia i wszystkie zapisane hasla');
    UpgradePage.SelectedValueIndex := 0;
  end;

  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Konfiguracja AdminReminder',
    'Port i publiczny adres aplikacji',
    'Port: na tym porcie usluga bedzie nasluchiwac (regula zapory Windows zostanie dodana automatycznie). ' +
    'Adres: uzywany w linkach wysylanych w mailach z powiadomieniami - wpisz tu adres, pod ktorym inni beda ' +
    'otwierac AdminReminder (np. adres tego serwera w sieci, albo docelowa nazwe za reverse proxy).' + #13#10#13#10 +
    'Oba ustawienia mozna pozniej zmienic edytujac plik .env w katalogu danych i restartujac usluge "AdminReminder".');
  ConfigPage.Add('Port TCP:', False);
  ConfigPage.Values[0] := '3000';
  ConfigPage.Add('Publiczny adres (APP_ORIGIN):', False);
  ConfigPage.Values[1] := DefaultAppOrigin;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortNum: Integer;
begin
  Result := True;
  if CurPageID = ConfigPage.ID then
  begin
    PortNum := StrToIntDef(ConfigPage.Values[0], -1);
    if (PortNum < 1) or (PortNum > 65535) then
    begin
      MsgBox('Podaj poprawny numer portu (1-65535).', mbError, MB_OK);
      Result := False;
      exit;
    end;
    if Trim(ConfigPage.Values[1]) = '' then
    begin
      MsgBox('Publiczny adres nie moze byc pusty.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure NssmExec(Params: String);
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{app}\nssm.exe'), Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  AppDirPath, DataDirPath, Port, Origin: String;
begin
  if CurStep = ssPostInstall then
  begin
    AppDirPath := ExpandConstant('{app}');
    DataDirPath := ExpandConstant('{commonappdata}\AdminReminder');
    Port := ConfigPage.Values[0];
    Origin := ConfigPage.Values[1];

    // Stop before touching any files under DataDirPath: a running service
    // holds the SQLite file open, and a wipe below must not fight the
    // service for that lock. Ignored if the service never existed.
    NssmExec('stop AdminReminder');

    if WipeRequested then
      DelTree(DataDirPath, True, True, True);

    ForceDirectories(DataDirPath + '\data');
    ForceDirectories(DataDirPath + '\logs');

    // Never overwrites an existing .env — an upgrade over a live install must
    // keep the secrets and any hand-added AD_*/AZURE_*/SMTP settings. When
    // WipeRequested wiped it above, this generates a brand new one instead.
    Exec(AppDirPath + '\node.exe',
      '"' + AppDirPath + '\generate-env.js" --data-dir "' + DataDirPath + '" --port "' + Port + '" --app-origin "' + Origin + '"',
      AppDirPath, SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // A re-run (upgrade/repair) must not fail on "service already exists" —
    // tear down whatever is there first, ignoring errors if it never existed.
    NssmExec('remove AdminReminder confirm');

    // node.exe directly, not through powershell.exe - see the file header.
    NssmExec('install AdminReminder "' + AppDirPath + '\node.exe"');
    NssmExec('set AdminReminder AppParameters "service-entry.js"');
    NssmExec('set AdminReminder AppDirectory "' + AppDirPath + '"');
    NssmExec('set AdminReminder DisplayName "AdminReminder"');
    NssmExec('set AdminReminder Description "Monitoring waznosci certyfikatow, kont AD, licencji i innych terminow"');
    NssmExec('set AdminReminder Start SERVICE_AUTO_START');
    NssmExec('set AdminReminder AppStdout "' + DataDirPath + '\logs\service.log"');
    NssmExec('set AdminReminder AppStderr "' + DataDirPath + '\logs\service.log"');
    NssmExec('set AdminReminder AppRotateFiles 1');
    NssmExec('set AdminReminder AppRotateBytes 10485760');
    NssmExec('set AdminReminder AppExit Default Restart');

    // LAN reachability out of the box; the operator can tighten scope later —
    // this is the same trade-off the Docker demo image makes with 0.0.0.0.
    // Scoped to node.exe itself (program=), not "any process on this port":
    // without it Windows Firewall treats the rule as a blanket port-open that
    // would keep working even if something else later listened on Port.
    Exec('netsh.exe',
      'advfirewall firewall add rule name="AdminReminder" dir=in action=allow protocol=TCP localport=' + Port +
      ' program="' + AppDirPath + '\node.exe"',
      AppDirPath, SW_HIDE, ewWaitUntilTerminated, ResultCode);

    NssmExec('start AdminReminder');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  AppDirPath, DataDirPath: String;
  DeleteData: Integer;
begin
  AppDirPath := ExpandConstant('{app}');
  DataDirPath := ExpandConstant('{commonappdata}\AdminReminder');

  // usUninstall fires before Setup removes any files, so nssm.exe is still
  // there to tear down the service it created.
  if CurUninstallStep = usUninstall then
  begin
    Exec(AppDirPath + '\nssm.exe', 'stop AdminReminder', AppDirPath, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(AppDirPath + '\nssm.exe', 'remove AdminReminder confirm', AppDirPath, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh.exe', 'advfirewall firewall delete rule name="AdminReminder"', AppDirPath, SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(DataDirPath) then
    begin
      DeleteData := MsgBox(
        'Usunac takze dane aplikacji (baza SQLite, wszystkie ustawienia i sekrety) z' + #13#10 + DataDirPath + '?' + #13#10#13#10 +
        'Wybierz "Nie", zeby zachowac je na wypadek ponownej instalacji.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
      if DeleteData = IDYES then
        DelTree(DataDirPath, True, True, True);
    end;
  end;
end;
