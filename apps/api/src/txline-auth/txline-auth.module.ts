import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletProvider } from './wallet.provider';
import { TxlineAuthService } from './txline-auth.service';

@Module({
  imports: [ConfigModule],
  providers: [WalletProvider, TxlineAuthService],
  exports: [TxlineAuthService, WalletProvider],
})
export class TxlineAuthModule {}
