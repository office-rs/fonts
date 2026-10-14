# Frequency data

`junda.txt` drives the frequency-clustered `common-*` slices in `tools/slice.py`.

Source: Jun Da, *Modern Chinese Character Frequency List*
(https://lingua.mtsu.edu/chinese-computing/statistics/char/), 9,933 characters,
publicly downloadable from that page.

Format: one `char<TAB>count` line per character, UTF-8, frequency-descending
(most frequent first). Regenerate from the site's CSV download
(`download.php?Which=MO`), which is GB18030-encoded and tab-delimited
(rank / char / frequency / cumulative % / pinyin / gloss) with a `/* ... */`
comment preamble — the conversion decodes GB18030, skips the comment lines,
and keeps the char and frequency columns.
