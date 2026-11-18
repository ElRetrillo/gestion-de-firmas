export interface DatosPlantillaCaducidad {
  nombre: string;
  rut: string;
  fechaVencimiento: string;
  diasRestantes: number;
  serialNumber?: string;
}

const escapeHtml = (str: string): string =>
  String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function generarPlantillaCorreoCaducidad(datos: DatosPlantillaCaducidad): {
  subject: string;
  text: string;
  html: string;
} {
  const nombre = (datos.nombre || 'Funcionario(a)').trim();
  const rut = (datos.rut || '-').trim();
  const fechaVencimiento = (datos.fechaVencimiento || '-').trim();
  const diasNum = Number(datos.diasRestantes ?? 0);
  const diasTexto =
    diasNum <= 0
      ? `Expirado hace ${Math.abs(diasNum)} ${Math.abs(diasNum) === 1 ? 'día' : 'días'}`
      : `${diasNum} ${diasNum === 1 ? 'día' : 'días'}`;

  const subject =
    diasNum <= 0
      ? `Aviso importante: Su certificado de Firma Electrónica ha caducado`
      : `Aviso importante: Su certificado de Firma Electrónica está por caducar (${diasTexto})`;

  const text = [
    '[Escudo Municipalidad]',
    'Aviso importante',
    'Su certificado de Firma Electrónica está por caducar',
    '',
    `Estimado(a) ${nombre},`,
    '',
    'Junto con saludar cordialmente, le informamos que su certificado de Firma Electrónica Avanzada se encuentra próximo a su fecha de vencimiento.',
    '',
    'Datos del certificado',
    `Titular: ${nombre}`,
    `RUT: `,
    `Fecha de vencimiento: ${fechaVencimiento}`,
    `Días restantes: ${diasTexto}`,
    '',
    'Pasos para la renovación — Cómo renovar su certificado a tiempo',
    '01 Responder este correo confirmando su intención de renovar el certificado.',
    '02 Adjuntar fotocopia del carnet de identidad por ambos lados, actualizada.',
    '03 Indicar teléfono de contacto institucional o personal.',
    '04 Si usted ya posee un token físico debe dirigirse al Departamento de Gestión de Sistemas y TICs para actualizar su certificado.',
    '05 Recibir notificación vía correo cuando el nuevo certificado esté disponible.',
    '',
    'Importante',
    'Una vez vencido el certificado, no podrá firmar digitalmente ningún documento hasta completar la renovación. Le recomendamos iniciar el proceso a la brevedad para evitar interrupciones en su gestión.',
    '',
    'Dónde realizar el trámite',
    'Oficina de Transformación Digital - piso 6, en horario laboral.',
    'Consultas: transformaciondigital@municoquimbo.cl',
    '',
    'Quedamos atentos a sus comentarios.',
    '',
    'Atte.',
    'Oficina de Transformación Digital',
    'Departamento de Gestión de Sistemas y TICS',
    'TEL +569 91682880 | MAIL transformaciondigital@municoquimbo.cl | WEB municoquimbo.cl',
    '',
    'Municipalidad - Comunicación Institucional',
    'Mensaje confidencial. Si no es el destinatario, elimínelo y notifique al remitente. No imprima si no es necesario.',
  ].join('\n');

  const html = `<div dir="ltr">
  <table border="0" cellpadding="0" cellspacing="0" width="600" align="center" style="font-family:Arial,Helvetica,sans-serif;font-size:medium;border-collapse:collapse;width:600px;max-width:600px;color:#211f19;border:1px solid #e8e8ec;background:#ffffff;">
    <tbody>
      <tr>
        <td bgcolor="#00163F" valign="middle" style="background:#00163F;padding:24px 28px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
            <tbody>
              <tr>
                <td width="130" valign="middle" style="width:130px;padding-right:18px;">
                  <img src="cid:escudo_municoquimbo" alt="Escudo Municipalidad" width="120" height="71" style="display:block;object-fit:contain;">
                </td>
                <td valign="middle" style="color:#ffffff;">
                  <div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#f4c9c8;text-transform:uppercase;margin-bottom:4px;">
                    Aviso importante
                  </div>
                  <div style="font-size:22px;font-weight:bold;line-height:1.25;">
                    Su certificado de Firma Electrónica está por caducar
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td bgcolor="#B1140F" height="4" style="height:4px;line-height:4px;font-size:0px;background:#B1140F;">&nbsp;</td>
      </tr>
      <tr>
        <td style="padding:24px 28px 4px;font-size:14px;line-height:1.6;">
          <p style="margin:0px 0px 12px;font-weight:bold;color:#00163F;font-size:15px;">
            Estimado(a) ${escapeHtml(nombre)},
          </p>
          <p style="margin:0px 0px 8px;">
            Junto con saludar cordialmente, le informamos que su <b style="color:#00163F;">certificado de Firma Electrónica Avanzada</b> se encuentra <b style="color:#B1140F;">próximo a su fecha de vencimiento</b>.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 28px 6px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#FCECEA" style="background:#FCECEA;border-collapse:collapse;border-left:4px solid #B1140F;">
            <tbody>
              <tr>
                <td style="padding:16px 18px;color:#7a0b08;">
                  <div style="font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:6px;">
                    Datos del certificado
                  </div>
                  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;line-height:1.6;">
                    <tbody>
                      <tr>
                        <td width="150" valign="top" style="width:150px;padding:2px 0px;"><b>Titular:</b></td>
                        <td valign="top" style="padding:2px 0px;color:#211f19;font-weight:bold;">${escapeHtml(nombre)}</td>
                      </tr>
                      <tr>
                        <td valign="top" style="padding:2px 0px;"><b>RUT:</b></td>
                        <td valign="top" style="padding:2px 0px;color:#211f19;">&nbsp;</td>
                      </tr>
                      <tr>
                        <td valign="top" style="padding:2px 0px;"><b>Fecha de vencimiento:</b></td>
                        <td valign="top" style="padding:2px 0px;color:#B1140F;font-weight:bold;">${escapeHtml(fechaVencimiento)}</td>
                      </tr>
                      <tr>
                        <td valign="top" style="padding:2px 0px;"><b>Días restantes:</b></td>
                        <td valign="top" style="padding:2px 0px;color:#211f19;font-weight:bold;">${escapeHtml(diasTexto)}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 28px 4px;">
          <div style="font-size:10px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:#5b5b5f;margin-bottom:4px;">
            Pasos para la renovación
          </div>
          <div style="font-size:16px;font-weight:bold;color:#00163F;line-height:1.3;">
            Cómo renovar su certificado a tiempo
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 28px 6px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;line-height:1.5;">
            <tbody>
              <tr>
                <td width="40" valign="top" style="width:40px;padding:10px 10px 10px 0px;">
                  <span style="display:inline-block;background:#EEF4FC;color:#003080;font-family:'Courier New',monospace;font-weight:bold;font-size:12px;padding:3px 8px;border-radius:3px;">01</span>
                </td>
                <td valign="top" style="padding:12px 0px;border-bottom:1px solid #f0f0f2;">
                  <b style="color:#00163F;">Responder este correo</b> confirmando su intención de renovar el certificado.
                </td>
              </tr>
              <tr>
                <td width="40" valign="top" style="width:40px;padding:10px 10px 10px 0px;">
                  <span style="display:inline-block;background:#EEF4FC;color:#003080;font-family:'Courier New',monospace;font-weight:bold;font-size:12px;padding:3px 8px;border-radius:3px;">02</span>
                </td>
                <td valign="top" style="padding:12px 0px;border-bottom:1px solid #f0f0f2;">
                  <b style="color:#00163F;">Adjuntar fotocopia</b> del carnet de identidad por ambos lados, actualizada.
                </td>
              </tr>
              <tr>
                <td width="40" valign="top" style="width:40px;padding:10px 10px 10px 0px;">
                  <span style="display:inline-block;background:#EEF4FC;color:#003080;font-family:'Courier New',monospace;font-weight:bold;font-size:12px;padding:3px 8px;border-radius:3px;">03</span>
                </td>
                <td valign="top" style="padding:12px 0px;border-bottom:1px solid #f0f0f2;">
                  <b style="color:#00163F;">Indicar teléfono de contacto</b> institucional o personal.
                </td>
              </tr>
              <tr>
                <td width="40" valign="top" style="width:40px;padding:10px 10px 10px 0px;">
                  <span style="display:inline-block;background:#EEF4FC;color:#003080;font-family:'Courier New',monospace;font-weight:bold;font-size:12px;padding:3px 8px;border-radius:3px;">04</span>
                </td>
                <td valign="top" style="padding:12px 0px;border-bottom:1px solid #f0f0f2;">
                  <b style="color:#00163F;">Si usted ya posee un token físico debe dirigirse</b> al Departamento de Gestión de Sistemas y TICs para actualizar su certificado.
                </td>
              </tr>
              <tr>
                <td width="40" valign="top" style="width:40px;padding:10px 10px 10px 0px;">
                  <span style="display:inline-block;background:#EEF4FC;color:#003080;font-family:'Courier New',monospace;font-weight:bold;font-size:12px;padding:3px 8px;border-radius:3px;">05</span>
                </td>
                <td valign="top" style="padding:12px 0px;">
                  <b style="color:#00163F;">Recibir notificación</b> vía correo cuando el nuevo certificado esté disponible.
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 28px 6px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#FFF8E6" style="background:#FFF8E6;border-collapse:collapse;border-left:4px solid #FFB202;">
            <tbody>
              <tr>
                <td style="padding:14px 18px;font-size:13px;line-height:1.55;color:#7a5200;">
                  <div style="font-weight:bold;font-size:14px;margin-bottom:4px;">Importante</div>
                  Una vez vencido el certificado, <b>no podrá firmar digitalmente</b> ningún documento hasta completar la renovación. Le recomendamos iniciar el proceso a la brevedad para evitar interrupciones en su gestión.
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 28px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#EEF4FC" style="background:#EEF4FC;border-collapse:collapse;border-left:4px solid #00163F;">
            <tbody>
              <tr>
                <td style="padding:14px 18px;font-size:13px;line-height:1.55;color:#00163F;">
                  <div style="font-weight:bold;font-size:14px;margin-bottom:4px;">Dónde realizar el trámite</div>
                  <b>Oficina de Transformación Digital</b> - piso 6, en horario laboral.<br>
                  Consultas: <b>transformaciondigital@municoquimbo.cl</b>
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px 4px;font-size:14px;line-height:1.6;">
          <p style="margin:0px 0px 6px;">Quedamos atentos a sus comentarios.</p>
          <p style="margin:0px;font-weight:bold;color:#00163F;font-size:13px;">Atte.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 28px 24px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
            <tbody>
              <tr>
                <td width="6" bgcolor="#00163F" style="width:6px;background:#00163F;line-height:0;font-size:0px;">&nbsp;</td>
                <td width="14" style="width:14px;">&nbsp;</td>
                <td valign="top">
                  <div style="font-weight:bold;font-size:15px;color:#00163F;line-height:1.2;">Oficina de Transformación Digital</div>
                  <div style="font-size:12px;color:#5b5b5f;margin-top:2px;">Departamento de Gestión de Sistemas y TICS</div>
                  <div style="font-size:11px;color:#5b5b5f;margin-top:8px;">
                    <b style="color:#00163F;text-transform:uppercase;letter-spacing:0.5px;">TEL</b> <a href="tel:+56991682880" target="_blank">+569 91682880</a>&nbsp;&nbsp;&nbsp;
                    <b style="color:#00163F;text-transform:uppercase;letter-spacing:0.5px;">MAIL</b> <a href="mailto:transformaciondigital@municoquimbo.cl" target="_blank">transformaciondigital@municoquimbo.cl</a>&nbsp;&nbsp;&nbsp;
                    <b style="color:#00163F;text-transform:uppercase;letter-spacing:0.5px;">WEB</b> <a href="http://municoquimbo.cl/" target="_blank">municoquimbo.cl</a>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
      <tr>
        <td bgcolor="#F7F7F9" style="background:#F7F7F9;border-top:1px solid #e8e8ec;padding:14px 28px;font-size:11px;color:#5b5b5f;line-height:1.55;">
          <div style="margin-bottom:6px;"><b style="color:#00163F;">Municipalidad - Comunicación Institucional</b></div>
          <div>Mensaje confidencial. Si no es el destinatario, elimínelo y notifique al remitente. No imprima si no es necesario.</div>
        </td>
      </tr>
    </tbody>
  </table>
  <br>
  <div style="text-align:left;max-width:600px;margin:0 auto;">
    <img src="https://www.municoquimbo.cl//images/estructura/2023/Marzo/firma-correo.jpg" alt="Firma Institucional Municipalidad de Coquimbo" style="max-width:100%;height:auto;">
  </div>
</div>`;

  return { subject, text, html };
}
