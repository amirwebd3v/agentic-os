# Converts one .docx to PDF through Word (career contract section 7). Called only by server/src/jobs/career-render.ts,
# which passes both paths as separate arguments (no shell string), checks they are inside dataDir/career/out, and kills
# this process and the Word it announces ("pid:<n>" on stdout) after 60 s. Exit 0 = PDF written.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'

$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
$word = New-Object -ComObject Word.Application
# A Word.Application COM object is always a new WINWORD process; announce it so the caller can kill a hung one.
$new = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
if ($new.Count -eq 1) { [Console]::Out.WriteLine("pid:$($new[0].Id)"); [Console]::Out.Flush() }

$doc = $null
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0 # wdAlertsNone
  # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
  $doc = $word.Documents.Open($In, $false, $true, $false)
  $doc.ExportAsFixedFormat($Out, 17) # wdExportFormatPDF
} finally {
  if ($doc) { $doc.Close(0) } # wdDoNotSaveChanges
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
