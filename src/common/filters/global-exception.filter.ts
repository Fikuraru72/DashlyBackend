import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Terjadi kesalahan pada server. Silakan coba beberapa saat lagi.';

    if (exception instanceof HttpException) {
      const responseBody: any = exception.getResponse();
      message = typeof responseBody === 'string' ? responseBody : responseBody.message || message;
    } else if (exception instanceof Error) {
      // In dev environment, we might want to log the error
      console.error(exception);
    }

    // Mapping custom user-facing messages based on backend exact scenarios
    const messageStr = Array.isArray(message) ? message[0] : message;
    let userFacingMessage = messageStr;

    // Authentication & Authorization
    if (status === 401 && messageStr.toLowerCase().includes('credentials')) {
      userFacingMessage = 'Email atau kata sandi yang Anda masukkan salah.';
    } else if (status === 401 && (messageStr.toLowerCase().includes('token') || messageStr.toLowerCase().includes('unauthorized'))) {
      userFacingMessage = 'Sesi Anda telah berakhir. Silakan login kembali.';
    } else if (status === 403 && messageStr.toLowerCase().includes('permission')) {
      userFacingMessage = 'Anda tidak memiliki akses untuk membuka halaman atau fitur ini.';
    } else if (status === 409 && messageStr.toLowerCase().includes('email')) {
      userFacingMessage = 'Email ini sudah terdaftar. Silakan gunakan email lain atau login.';
    }

    // Event & Registration
    else if (status === 404 && messageStr.toLowerCase().includes('event')) {
      userFacingMessage = 'Event yang Anda cari tidak ditemukan atau sudah dihapus.';
    } else if (status === 403 && messageStr.toLowerCase().includes('currently open')) {
      userFacingMessage = 'Pendaftaran untuk event ini belum dibuka atau tidak aktif.';
    } else if (status === 403 && messageStr.toLowerCase().includes('deadline')) {
      userFacingMessage = 'Pendaftaran gagal karena batas waktu pendaftaran telah lewat.';
    } else if (status === 403 && messageStr.toLowerCase().includes('capacity')) {
      userFacingMessage = 'Mohon maaf, kuota peserta untuk event ini sudah penuh.';
    } else if (status === 409 && messageStr.toLowerCase().includes('already joined')) {
      userFacingMessage = 'Anda sudah terdaftar sebagai peserta di event ini.';
    } else if (status === 409 && messageStr.toLowerCase().includes('already registered')) {
      userFacingMessage = 'Anda sudah terdaftar sebagai peserta di event ini.';
    }

    // Validation & Form
    else if (status === 400 && messageStr.toLowerCase().includes('gpx')) {
      userFacingMessage = 'File rute yang Anda unggah bukan format GPX yang valid.';
    } else if (status === 413) {
      userFacingMessage = 'File yang diunggah terlalu besar. Pastikan ukuran file sesuai batasan.';
    } else if (status === 400) {
      // General bad request (validation errors)
      userFacingMessage = messageStr; // Let class-validator messages pass through or generic
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message: userFacingMessage,
      originalMessage: messageStr, // Helpful for debugging
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
