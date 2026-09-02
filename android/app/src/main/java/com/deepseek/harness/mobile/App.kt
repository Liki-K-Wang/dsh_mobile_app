package com.deepseek.harness.mobile

import android.app.Activity
import android.app.Application
import android.os.Bundle

/**
 * 应用入口（v1.3.2）：启动本地调试端口并记录前台 Activity 供 /status 查询。
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()
        DebugServer.start(this)
        registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                DebugServer.State.foregroundActivity = activity.javaClass.simpleName
            }

            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        })
    }
}
