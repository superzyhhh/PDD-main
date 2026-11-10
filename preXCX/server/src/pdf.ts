/**
 * 最小 PDF 写入器：把每页 JPEG 作为 DCTDecode 图像嵌入 A4 页面，无第三方依赖。
 * 只处理本项目需要的「每页一张满版图片」场景。
 */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

export interface PdfImagePage {
  jpeg: Buffer;
  width: number;
  height: number;
}

export function buildPdfFromJpegPages(pages: PdfImagePage[]): Buffer {
  if (pages.length === 0) throw new Error('PDF 至少需要一页');

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Buffer | string): void => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    chunks.push(buffer);
    length += buffer.length;
  };
  const startObject = (number: number): void => {
    offsets[number] = length;
  };

  push('%PDF-1.4\n');
  startObject(1);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const pageObjectNumbers = pages.map((_, index) => 3 + index * 3);
  startObject(2);
  push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(' ')}] ` +
      `/Count ${pages.length} >>\nendobj\n`,
  );

  pages.forEach((page, index) => {
    const pageNumber = 3 + index * 3;
    const contentNumber = pageNumber + 1;
    const imageNumber = pageNumber + 2;

    startObject(pageNumber);
    push(
      `${pageNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}] ` +
        `/Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>\nendobj\n`,
    );

    const content = `q\n${A4_WIDTH_PT} 0 0 ${A4_HEIGHT_PT} 0 0 cm\n/Im0 Do\nQ\n`;
    startObject(contentNumber);
    push(
      `${contentNumber} 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n` +
        `${content}endstream\nendobj\n`,
    );

    startObject(imageNumber);
    push(
      `${imageNumber} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = length;
  const maxObjectNumber = 2 + pages.length * 3;
  push(`xref\n0 ${maxObjectNumber + 1}\n0000000000 65535 f \n`);
  for (let number = 1; number <= maxObjectNumber; number++) {
    push(`${String(offsets[number] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${maxObjectNumber + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}
