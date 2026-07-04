import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { CustomCacheModule } from "./cache";
import { DbModule } from "./config/database.config";
import { QueueModule } from "./queue/queue.module";
import { WebhookModule } from "./webhook/webhook.module";
import { ApiModule } from "./api/api.module";
import { MaintainerModule } from "./maintainer/maintainer.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env"],
    }),
    ScheduleModule.forRoot(),
    CustomCacheModule,
    DbModule,
    QueueModule,
    WebhookModule,
    ApiModule,
    MaintainerModule,
  ],
})
export class AppModule {}
